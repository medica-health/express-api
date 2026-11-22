-- Resend message id for each sent email, to trace deliveries in the Resend dashboard.
ALTER TABLE app.notifications_log ADD COLUMN provider_message_id text;
