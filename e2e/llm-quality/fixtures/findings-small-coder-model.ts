/**
 * Hand-curated "small coder model" (deepseek-coder:6.7b / qwen2.5-coder:7b)
 * raw findings. These models paraphrase the source: change quote styles,
 * normalize whitespace, drop trailing commas/semicolons, swap singular
 * for plural, omit type annotations. None of the snippets here are exact
 * substrings of `BENCH_SOURCE` — they're all paraphrases that the relaxed
 * tolerance should still accept.
 *
 * Floors expected (#605):
 *   • STRICT tolerance:  ≤ 30% keep-rate (most paraphrases reject — this
 *                        is exactly the failure mode that motivated #605).
 *   • RELAXED tolerance: ≥ 50% keep-rate.
 *
 * The boundary cases (a few paraphrases that should reject even relaxed)
 * are marked `expectedKept: false` so the bench can also assert it's not
 * over-permissive.
 */
import type { BenchFinding } from './findings-capable-model';

export const SMALL_CODER_FINDINGS: BenchFinding[] = [
    // ─── Paraphrases relaxed should ACCEPT ────────────────────────────────
    {
        title: 'Trim transforms could be on one line',
        // Original: `const password = input.password?.trim();`
        snippet: `const password = input.password.trim()`,
        expectedKept: true,
    },
    {
        title: 'bcrypt salt rounds hardcoded',
        // Original: `const hashedPassword = await bcrypt.hash(password, 10);`
        snippet: `const hashedPassword = await bcrypt.hash(password, 10)`,
        expectedKept: true,
    },
    {
        title: 'Password compared via bcrypt',
        // Original: `const match = await bcrypt.compare(password, user.password);`
        snippet: `const match = await bcrypt.compare(password, user.password)`,
        expectedKept: true,
    },
    {
        title: 'User select clause may be too narrow',
        // Original (multi-line):
        //   select: {
        //     id: true,
        //     email: true,
        //     username: true,
        //   },
        snippet: `select: { id: true, email: true, username: true, }`,
        expectedKept: true,
    },
    {
        title: 'Prisma create with username, email, password',
        // Original:
        //   data: {
        //     username,
        //     email,
        //     password: hashedPassword,
        //   },
        snippet: `data: { username, email, password: hashedPassword, }`,
        expectedKept: true,
    },
    {
        title: 'Token call uses user id',
        // Original: `token: generateToken(user.id),`
        snippet: `token: generateToken(user.id)`,
        expectedKept: true,
    },
    {
        title: 'getCurrentUser checks for falsy id',
        // Original: `if (!id) {`
        snippet: `if (!id) {`, // exact — included as control
        expectedKept: true,
    },
    {
        title: 'findUnique by email returns full user',
        // Original (multi-line):
        //   const user = await prisma.user.findUnique({
        //     where: { email },
        //     select: { id: true, email: true, password: true },
        //   });
        snippet: `const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, password: true } })`,
        expectedKept: true,
    },
    {
        title: '403 thrown on invalid credentials',
        // Original (multi-line):
        //   throw new HttpException(403, {
        //     errors: { 'email or password': ['is invalid'] },
        //   });
        snippet: `throw new HttpException(403, { errors: { "email or password": ["is invalid"] } })`,
        expectedKept: true,
    },
    {
        title: 'Auth required HttpException',
        // Original: `throw new HttpException(401, { errors: { authorization: ['is required'] } });`
        snippet: `throw new HttpException(401, { errors: { authorization: ["is required"] } })`,
        expectedKept: true,
    },

    // ─── Cases that should REJECT even under relaxed ─────────────────────
    {
        title: 'Hallucinated DB cleanup',
        snippet: `await prisma.user.deleteAll({ confirm: true })`,
        expectedKept: false,
    },
    {
        title: 'Snippet from a different file entirely',
        snippet: `app.use("/api/v2/router", versionedHandler);`,
        expectedKept: false,
    },
    {
        title: 'Hallucinated React hook',
        snippet: `useEffect(() => { fetchProfile(); }, [userId]);`,
        expectedKept: false,
    },
];
