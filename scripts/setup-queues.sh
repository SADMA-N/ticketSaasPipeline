#!/bin/bash
set -e
AWS="aws --profile localstack --endpoint-url http://localhost:4566 --region us-east-1"

# Delete existing queues if they exist
$AWS sqs delete-queue --queue-url http://localhost:4566/000000000000/ticket-queue 2>/dev/null || true
$AWS sqs delete-queue --queue-url http://localhost:4566/000000000000/ticket-queue-dlq 2>/dev/null || true
sleep 1

DLQ_URL=$($AWS sqs create-queue --queue-name ticket-queue-dlq --query QueueUrl --output text)
DLQ_ARN=$($AWS sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

TMPFILE=$(mktemp)
cat > "$TMPFILE" << EOF
{
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"3\"}"
}
EOF

$AWS sqs create-queue --queue-name ticket-queue --attributes "file://$TMPFILE"
rm "$TMPFILE"

echo "Queues ready. DLQ ARN: $DLQ_ARN"