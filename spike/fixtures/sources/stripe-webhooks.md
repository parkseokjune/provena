# Verifying Stripe Webhook Signatures

Stripe signs each webhook event with a secret and sends the signature in the
Stripe-Signature header. To verify, compute an HMAC-SHA256 of the raw request body
using your endpoint signing secret, then compare it to the signature in the header
using a constant-time comparison to avoid timing attacks.

Reject the event if the timestamp in the header is more than five minutes old,
which protects against replay of intercepted webhook payloads.
