# Conversation requirements (user turns)

turn#4 user: For our app, refresh tokens should last 30 days, not the default.
turn#4 user: Store the refresh token hashed in the database, never in plaintext.
turn#7 user: The login endpoint should rate-limit to 5 attempts per minute per IP.
