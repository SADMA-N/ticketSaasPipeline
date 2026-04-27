npm run dev:server
npm run dev:worker
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test aws sqs create-queue --queue-name ticket-queue --endpoint-url http://localhost:4566 --region us-east-1