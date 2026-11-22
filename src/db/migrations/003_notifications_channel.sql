-- Delivery channel for each notification (email via Resend, SMS via Twilio).
ALTER TABLE app.notifications_log
  ADD COLUMN channel text NOT NULL DEFAULT 'EMAIL' CHECK (channel IN ('EMAIL','SMS'));
