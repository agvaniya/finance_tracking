"""Point a Route 53 A record at the Fargate task that just started.

Triggered by EventBridge on ECS Task State Change. The event carries the
task's ENI id but not its public IP, so the IP is looked up on the interface
and written to the record with a short TTL.
"""

import logging
import os

import boto3

log = logging.getLogger()
log.setLevel(logging.INFO)

ec2 = boto3.client("ec2")
route53 = boto3.client("route53")

HOSTED_ZONE_ID = os.environ["HOSTED_ZONE_ID"]
RECORD_NAME = os.environ["RECORD_NAME"]
CLUSTER_ARN = os.environ["CLUSTER_ARN"]
RECORD_TTL = int(os.environ.get("RECORD_TTL", "60"))


def _network_interface_id(detail):
    for attachment in detail.get("attachments", []):
        if attachment.get("type") not in ("eni", "ElasticNetworkInterface"):
            continue
        for item in attachment.get("details", []):
            if item.get("name") == "networkInterfaceId":
                return item.get("value")
    return None


def _public_ip(eni_id):
    interfaces = ec2.describe_network_interfaces(NetworkInterfaceIds=[eni_id])
    for interface in interfaces.get("NetworkInterfaces", []):
        ip = interface.get("Association", {}).get("PublicIp")
        if ip:
            return ip
    return None


def handler(event, context):
    detail = event.get("detail", {})

    # The rule already filters on these, but a stray event should be ignored
    # rather than allowed to repoint the record at the wrong task.
    if detail.get("clusterArn") != CLUSTER_ARN:
        log.info("Ignoring event from another cluster: %s", detail.get("clusterArn"))
        return {"updated": False, "reason": "other-cluster"}

    if detail.get("lastStatus") != "RUNNING" or detail.get("desiredStatus") != "RUNNING":
        log.info(
            "Ignoring task in state last=%s desired=%s",
            detail.get("lastStatus"),
            detail.get("desiredStatus"),
        )
        return {"updated": False, "reason": "not-running"}

    eni_id = _network_interface_id(detail)
    if not eni_id:
        log.warning("Task %s has no ENI attachment yet", detail.get("taskArn"))
        return {"updated": False, "reason": "no-eni"}

    ip = _public_ip(eni_id)
    if not ip:
        log.warning("ENI %s has no public IP association", eni_id)
        return {"updated": False, "reason": "no-public-ip"}

    route53.change_resource_record_sets(
        HostedZoneId=HOSTED_ZONE_ID,
        ChangeBatch={
            "Comment": f"Ledgerline task {detail.get('taskArn', 'unknown')}",
            "Changes": [
                {
                    "Action": "UPSERT",
                    "ResourceRecordSet": {
                        "Name": RECORD_NAME,
                        "Type": "A",
                        "TTL": RECORD_TTL,
                        "ResourceRecords": [{"Value": ip}],
                    },
                }
            ],
        },
    )

    log.info("Pointed %s at %s (eni %s)", RECORD_NAME, ip, eni_id)
    return {"updated": True, "record": RECORD_NAME, "ip": ip}
