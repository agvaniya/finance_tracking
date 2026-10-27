"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "./db";
import { isTheme } from "./theme";
import {
  clearAttempts,
  createSession,
  setThemeCookie,
  destroySession,
  recordFailedAttempt,
  requireUserId,
  tooManyAttempts,
} from "./auth";
import { hashAnswer, hashSecret, verifyAnswer, verifySecret } from "./password";
import { SECURITY_QUESTIONS } from "./securityQuestions";

export interface ActionState {
  ok?: boolean;
  error?: string;
}


const QUESTION_COUNT = 2;
const MIN_PASSWORD = 10;

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

function validateUsername(username: string): string | null {
  if (username.length < 3 || username.length > 32) {
    return "Username must be between 3 and 32 characters.";
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return "Username can contain letters, numbers, dots, dashes and underscores.";
  }
  return null;
}

function validatePassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters.`;
  }
  if (password !== confirm) return "The two passwords do not match.";
  return null;
}

// ---------------------------------------------------------------------------
// Sign up
// ---------------------------------------------------------------------------

export async function signUp(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const username = text(formData, "username");
  const usernameError = validateUsername(username);
  if (usernameError) return { error: usernameError };

  const password = String(formData.get("password") ?? "");
  const passwordError = validatePassword(password, String(formData.get("confirmPassword") ?? ""));
  if (passwordError) return { error: passwordError };

  const questions: { question: string; answer: string; position: number }[] = [];
  for (let i = 0; i < QUESTION_COUNT; i++) {
    const question = text(formData, `question${i}`);
    const answer = text(formData, `answer${i}`);
    // Only questions from the published list are accepted, so a crafted form
    // cannot store arbitrary text as a prompt.
    if (!(SECURITY_QUESTIONS as readonly string[]).includes(question)) {
      return { error: "Choose both security questions." };
    }
    if (answer.length < 2) return { error: "Answer both security questions." };
    questions.push({ question, answer, position: i });
  }
  if (questions[0].question === questions[1].question) {
    return { error: "Choose two different security questions." };
  }

  const taken = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (taken) return { error: "That username is already taken." };

  const [passwordHash, ...answerHashes] = await Promise.all([
    hashSecret(password),
    ...questions.map((q) => hashAnswer(q.answer)),
  ]);

  // The very first account adopts any data that predates multi-user support,
  // so upgrading an existing single-user install loses nothing.
  const isFirstUser = (await prisma.user.count()) === 0;

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        username,
        passwordHash,
        securityQuestions: {
          create: questions.map((q, i) => ({
            question: q.question,
            answerHash: answerHashes[i],
            position: q.position,
          })),
        },
      },
    });

    if (isFirstUser) {
      await tx.creditCard.updateMany({ where: { userId: null }, data: { userId: created.id } });
      await tx.checkingAccount.updateMany({ where: { userId: null }, data: { userId: created.id } });
    }
    return created;
  });

  await createSession(user.id);
  redirect("/");
}

// ---------------------------------------------------------------------------
// Sign in / out
// ---------------------------------------------------------------------------

export async function signIn(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const username = text(formData, "username");
  const password = String(formData.get("password") ?? "");

  const throttleKey = `login:${username.toLowerCase()}`;
  if (tooManyAttempts(throttleKey)) {
    return { error: "Too many attempts. Wait a few minutes and try again." };
  }

  const user = await prisma.user.findUnique({ where: { username } });
  // Same message either way, so the form cannot be used to enumerate accounts.
  const invalid = { error: "Username or password is not correct." };
  if (!user) {
    recordFailedAttempt(throttleKey);
    return invalid;
  }
  if (!(await verifySecret(password, user.passwordHash))) {
    recordFailedAttempt(throttleKey);
    return invalid;
  }

  clearAttempts(throttleKey);
  await createSession(user.id);
  redirect("/");
}

/** Remembers the appearance choice on the account and on this browser. */
export async function setTheme(theme: string): Promise<void> {
  const userId = await requireUserId();
  if (!isTheme(theme)) return;
  await prisma.user.update({ where: { id: userId }, data: { theme } });
  await setThemeCookie(theme);
  revalidatePath("/", "layout");
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect("/login");
}

// ---------------------------------------------------------------------------
// Forgotten password
// ---------------------------------------------------------------------------

/** Step one: look up the questions to put in front of the person resetting. */
export async function lookupSecurityQuestions(
  _prev: ActionState & { questions?: string[]; username?: string },
  formData: FormData
): Promise<ActionState & { questions?: string[]; username?: string }> {
  const username = text(formData, "username");
  const user = await prisma.user.findUnique({
    where: { username },
    select: { securityQuestions: { orderBy: { position: "asc" }, select: { question: true } } },
  });

  if (!user || user.securityQuestions.length === 0) {
    return { error: "No account with security questions was found for that username." };
  }
  return { ok: true, username, questions: user.securityQuestions.map((q) => q.question) };
}

/** Step two: both answers must be right before a new password is accepted. */
export async function resetPassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const username = text(formData, "username");

  const throttleKey = `reset:${username.toLowerCase()}`;
  if (tooManyAttempts(throttleKey)) {
    return { error: "Too many attempts. Wait a few minutes and try again." };
  }

  const password = String(formData.get("password") ?? "");
  const passwordError = validatePassword(password, String(formData.get("confirmPassword") ?? ""));
  if (passwordError) return { error: passwordError };

  const user = await prisma.user.findUnique({
    where: { username },
    include: { securityQuestions: { orderBy: { position: "asc" } } },
  });
  if (!user || user.securityQuestions.length === 0) {
    recordFailedAttempt(throttleKey);
    return { error: "Those answers are not correct." };
  }

  // Check every answer rather than stopping at the first failure, so the
  // response time does not reveal which one was wrong.
  const outcomes = await Promise.all(
    user.securityQuestions.map((q, i) => verifyAnswer(text(formData, `answer${i}`), q.answerHash))
  );
  if (outcomes.some((ok) => !ok)) {
    recordFailedAttempt(throttleKey);
    return { error: "Those answers are not correct." };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashSecret(password) },
  });

  clearAttempts(throttleKey);
  // Sign in directly — the answers just proved ownership.
  await createSession(user.id);
  redirect("/");
}

// ---------------------------------------------------------------------------
// Signed-in account management
// ---------------------------------------------------------------------------

export async function changePassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const current = String(formData.get("currentPassword") ?? "");
  if (!(await verifySecret(current, user.passwordHash))) {
    return { error: "Your current password is not correct." };
  }

  const password = String(formData.get("password") ?? "");
  const passwordError = validatePassword(password, String(formData.get("confirmPassword") ?? ""));
  if (passwordError) return { error: passwordError };

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashSecret(password) },
  });
  return { ok: true };
}

/** Deleting the account removes every card, balance and schedule it owns. */
export async function deleteAccount(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  if (!(await verifySecret(String(formData.get("password") ?? ""), user.passwordHash))) {
    return { error: "Your password is not correct." };
  }
  if (text(formData, "confirmUsername") !== user.username) {
    return { error: `Type ${user.username} exactly to confirm.` };
  }

  // Cascades reach cards, accounts, schedules, adjustments and history.
  await prisma.user.delete({ where: { id: userId } });
  await destroySession();
  revalidatePath("/", "layout");
  redirect("/login?deleted=1");
}
