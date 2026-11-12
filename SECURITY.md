# Security

Koi suraksha ki kami (vulnerability) mile to **public issue/MR me mat likho**. Seedha is par batao: **[apna email]**
(GitHub par: Security tab → "Report a vulnerability"; GitLab par: confidential issue).

Batate waqt likho: kya mila, kaise dohraya ja sakta hai, aur kitna asar hai. Hum jaldi jawab dene ki koshish karenge.

## Abhi ke suraksha upay
- Password scrypt se hash; recovery code bhi hash.
- Login token signed (HMAC) aur har password badalne/logout-all par bekaar ho jaata hai.
- Login/recovery par IP ke hisab se aur username ke hisab se rok (8 galat koshish / 15 min).
- Har request par rate limit; DM par 30/minute.
- Photo sirf jpeg/png/webp data URL, 1.5MB tak.
- `X-Frame-Options`, `nosniff`, CSP (frame-ancestors), Permissions-Policy.

## Jo abhi nahi hai (jaante hain)
- DM end-to-end encrypted nahi hain.
- Rate limit memory me hai (ek server ke liye).
- Email/OTP wala login nahi — recovery code se password wapas aata hai.
