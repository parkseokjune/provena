# OAuth2 Authorization Code Flow — Internal Spec

The client redirects the user to the authorization endpoint with response_type=code.
After the user consents, the server returns an authorization code via the redirect URI.
The client then exchanges this code at the token endpoint for an access token and a refresh token.

Access tokens are short-lived JWTs signed with HS256 and expire after 15 minutes.
The token endpoint must reject any authorization code that has already been redeemed once,
to prevent replay attacks. Authorization codes expire 60 seconds after issuance.
