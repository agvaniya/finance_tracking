/**
 * Kept out of the "use server" action module, which may only export async
 * functions — both the server actions and the signup form read this list.
 */
export const SECURITY_QUESTIONS = [
  "What was the name of your first pet?",
  "What city were you born in?",
  "What was the name of your first school?",
  "What is your mother's maiden name?",
  "What was the make of your first car?",
  "What is the name of your oldest cousin?",
  "What street did you live on growing up?",
  "What was your childhood nickname?",
] as const;
