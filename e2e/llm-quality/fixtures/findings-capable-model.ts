/**
 * Hand-curated "capable model" (GPT-4o / Claude-3.5 Sonnet / GPT-4o-mini)
 * raw findings. Models in this class quote source verbatim — so every
 * snippet here is a literal substring of `BENCH_SOURCE`. The bench expects
 * a ≥ 90% keep-rate under STRICT tolerance against this fixture (#605).
 *
 * "Raw" = pre-gate. The bench applies the gate to each finding and counts
 * survivors.
 */
export interface BenchFinding {
    title: string;
    snippet: string;
    expectedKept: boolean;  // documents the bench author's expectation
}

export const CAPABLE_MODEL_FINDINGS: BenchFinding[] = [
    {
        title: 'No rate limiting on registration',
        snippet: `const user = await prisma.user.create({`,
        expectedKept: true,
    },
    {
        title: 'Password validation missing length check',
        snippet: `const password = input.password?.trim();`,
        expectedKept: true,
    },
    {
        title: 'bcrypt rounds may be too low',
        snippet: `const hashedPassword = await bcrypt.hash(password, 10);`,
        expectedKept: true,
    },
    {
        title: 'No email format validation',
        snippet: `const email = input.email?.trim();`,
        expectedKept: true,
    },
    {
        title: 'Vague auth-error response',
        snippet: `throw new HttpException(403, {`,
        expectedKept: true,
    },
    {
        title: 'Hardcoded HTTP status without constant',
        snippet: `throw new HttpException(422, { errors: { email: ["can't be blank"] } });`,
        expectedKept: true,
    },
    {
        title: 'Password compared after lookup — timing attack',
        snippet: `const match = await bcrypt.compare(password, user.password);`,
        expectedKept: true,
    },
    {
        title: 'Token issued without expiry check',
        snippet: `token: generateToken(user.id),`,
        expectedKept: true,
    },
    {
        title: 'Missing authorization check on get-current-user',
        snippet: `if (!id) {`,
        expectedKept: true,
    },
    {
        title: 'Select clause omits username on login',
        snippet: `where: { email },`,
        expectedKept: true,
    },
    // One deliberate hallucination — model invented a line that isn't in source.
    {
        title: 'Hallucinated finding about a method that does not exist',
        snippet: `await prisma.user.deleteAll({ confirm: true });`,
        expectedKept: false,
    },
];
