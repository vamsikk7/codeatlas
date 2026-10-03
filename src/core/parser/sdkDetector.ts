/**
 * sdkDetector.ts — Third-party SDK detection for FE/mobile services.
 *
 * v2 phase 2 (#482 — L1: third-party SDK detection (FE/mobile)) per `docs/v2-frontend-mobile-layer-spec.md` §3 (L1):
 * frontend + mobile services expose meaningful outward edges that today's
 * `serviceDetector.ts` doesn't surface — Stripe, Auth0, Sentry, Mixpanel,
 * Segment, Apollo Client, Firebase, FCM, OneSignal, RevenueCat, AdMob,
 * Branch, Crashlytics, Google Analytics. These all live as imports in
 * file graphs but never reach L1.
 *
 * This module exports a curated catalog (`SDK_CATALOG`) and a single
 * detector (`detectSdks`) that scans a service's files and returns one
 * `SdkDependency` per matched SDK. Downstream the L1 microservice graph
 * builder (#482 PR-C) renders these as `'sdk'`-kind `InfrastructureService`
 * nodes alongside today's database / cache / queue infra.
 *
 * Detection is regex-based on file content, intentionally mirroring how
 * `detectTechnology` already works in `serviceDetector.ts`. The catalog
 * is deliberately conservative (start small, extend per real-repo
 * evidence) — 14 SDKs to start covers the surface area most FE/mobile
 * teams care about. New entries are one-line catalog adds.
 *
 * Why content-regex instead of `FileRecord.symbols.imports`: imports
 * lose their full module path after tree-sitter extraction in some
 * non-JS languages, and the curated regexes need to match specific
 * sub-paths (e.g. `@firebase/firestore` vs `@firebase/auth`) which the
 * import-array form drops. The cost is one extra content scan per
 * service per refresh, which is negligible (50KB cap per file,
 * `getContent` fallback handles lazy content).
 *
 * Each rule carries:
 *   - `id`            — stable identifier used by the L1 builder for node IDs
 *   - `name`          — display label
 *   - `category`      — broad function bucket; drives icon / color in L1
 *   - `importPatterns`— any one regex match counts as detection
 *   - `languages`     — language allowlist; rule only fires on files of
 *                       these languages (cheap pre-filter to keep the
 *                       cross-product manageable)
 */

import type { FileRecord } from '../graph/graphTypes';
import type { SupportedLanguage } from './treeSitterParser';

export type SdkCategory =
    | 'payments'
    | 'auth'
    | 'observability'
    | 'analytics'
    | 'push'
    | 'crash'
    | 'ads'
    | 'graphql'
    | 'baas'              // backend-as-a-service (Firebase, Supabase, etc.)
    | 'attribution'
    | 'ai'                // LLM / model providers (OpenAI, Anthropic, …)
    | 'comms'             // messaging / mail (Twilio, SendGrid, Slack, …)
    | 'storage';          // object stores (AWS S3, GCS, Azure Blob, …)

export interface SdkDetectionRule {
    id: string;
    name: string;
    category: SdkCategory;
    importPatterns: RegExp[];
    languages: SupportedLanguage[];
}

export interface SdkDependency {
    sdkId: string;
    name: string;
    category: SdkCategory;
    /**
     * File paths where the SDK's imports were detected. Capped at 5
     * entries so a workspace-wide hit doesn't bloat the snapshot —
     * downstream L1 cares about presence, not which file uses it.
     */
    matchedFiles: string[];
}

/**
 * Curated catalog of third-party SDKs that surface as L1 nodes for
 * FE/mobile services. Order is arbitrary — `detectSdks` always emits
 * results in catalog order for stable diff output.
 *
 * Adding an SDK: append a new entry with the most-specific import
 * patterns you can write. The patterns SHOULD anchor on `from` /
 * `import` / `require` / `using` / `use` keywords to avoid matching
 * arbitrary strings — false positives are worse than misses here
 * because every false-positive becomes a phantom L1 node.
 */
export const SDK_CATALOG: SdkDetectionRule[] = [
    {
        id: 'stripe',
        name: 'Stripe',
        category: 'payments',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]@stripe\/(?:stripe-js|react-stripe-js|stripe-react-native|connect-js)['"]/,
            /(?:from|import|require)\s*\(?\s*['"]stripe['"]/,             // Node SDK / Python `import stripe`
            /\bimport\s+stripe\b/,                                          // Python
            /\bimport\s+com\.stripe\b/,                                     // Java / Kotlin
            /\busing\s+Stripe\b/,                                           // .NET
            /\brequire\s+['"]stripe['"]/,                                   // Ruby
            /github\.com\/stripe\/stripe-go/,                               // Go
        ],
        languages: ['javascript', 'typescript', 'python', 'java', 'kotlin', 'csharp', 'ruby', 'go'],
    },
    {
        id: 'auth0',
        name: 'Auth0',
        category: 'auth',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]@auth0\/(?:auth0-react|auth0-spa-js|nextjs-auth0|auth0-angular|auth0-vue|auth0-react-native)['"]/,
            /(?:from|import|require)\s*\(?\s*['"]auth0['"]/,
            /\bimport\s+auth0\b/,                                           // Python
            /\bimport\s+Auth0\b/,                                           // Swift (Auth0.swift)
            /\bimport\s+com\.auth0\b/,                                      // Android
        ],
        languages: ['javascript', 'typescript', 'python', 'swift', 'java', 'kotlin'],
    },
    {
        id: 'sentry',
        name: 'Sentry',
        category: 'observability',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]@sentry\/(?:browser|node|react|react-native|nextjs|vue|nuxt|svelte|electron|cli)['"]/,
            /(?:from|import|require)\s*\(?\s*['"]sentry-expo['"]/,
            /\bimport\s+sentry_sdk\b/,                                      // Python
            /\bimport\s+io\.sentry\b/,                                      // Java / Kotlin
            /\bimport\s+Sentry\b/,                                          // Swift
            /\bsentry-java['"]?/,                                           // Gradle deps
        ],
        languages: ['javascript', 'typescript', 'python', 'java', 'kotlin', 'swift'],
    },
    {
        id: 'mixpanel',
        name: 'Mixpanel',
        category: 'analytics',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]mixpanel(?:-browser|-react-native)?['"]/,
            /\bimport\s+mixpanel\b/,                                        // Python
            /\bimport\s+Mixpanel\b/,                                        // Swift (Mixpanel-swift)
            /\bimport\s+com\.mixpanel\.android\b/,
        ],
        languages: ['javascript', 'typescript', 'python', 'swift', 'java', 'kotlin'],
    },
    {
        id: 'segment',
        name: 'Segment',
        category: 'analytics',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]@segment\/(?:analytics-next|analytics-node|analytics-react-native|analytics-react)['"]/,
            /(?:from|import|require)\s*\(?\s*['"]analytics-node['"]/,
            /\bimport\s+segment_analytics\b/,                               // Python (analytics-python)
            /\bimport\s+Segment\b/,                                         // Swift
        ],
        languages: ['javascript', 'typescript', 'python', 'swift', 'java', 'kotlin'],
    },
    {
        id: 'apollo-client',
        name: 'Apollo Client',
        category: 'graphql',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]@apollo\/(?:client|react-hooks|react-components|link-[\w-]+)['"]/,
            /(?:from|import|require)\s*\(?\s*['"]apollo-(?:client|link|cache-inmemory|boost)['"]/,
            /\bimport\s+Apollo\b/,                                          // Apollo iOS
            /\bimport\s+com\.apollographql\b/,                              // Apollo Android
        ],
        languages: ['javascript', 'typescript', 'swift', 'java', 'kotlin'],
    },
    {
        id: 'firebase',
        name: 'Firebase',
        category: 'baas',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]firebase\/(?:app|auth|firestore|database|storage|functions|analytics|messaging|remote-config|performance|crashlytics)['"]/,
            /(?:from|import|require)\s*\(?\s*['"]@firebase\/[\w-]+['"]/,
            /(?:from|import|require)\s*\(?\s*['"]@react-native-firebase\/[\w-]+['"]/,
            /(?:from|import|require)\s*\(?\s*['"]firebase['"]/,             // bare bundle
            /\bimport\s+['"]package:firebase_(?:core|auth|firestore|messaging|analytics|storage|crashlytics)\//,
            /\bimport\s+Firebase[A-Z][\w]*\b/,                              // Swift (Firebase modules)
            /\bimport\s+com\.google\.firebase\b/,                           // Android
        ],
        languages: ['javascript', 'typescript', 'dart', 'swift', 'java', 'kotlin'],
    },
    {
        id: 'fcm',
        name: 'Firebase Cloud Messaging (FCM)',
        category: 'push',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]@react-native-firebase\/messaging['"]/,
            /(?:from|import|require)\s*\(?\s*['"]firebase\/messaging['"]/,
            /\bimport\s+['"]package:firebase_messaging\//,
            /\bimport\s+com\.google\.firebase\.messaging\b/,
            /\bclass\s+\w+\s*:\s*FirebaseMessagingService\b/,                // Android subclass
        ],
        languages: ['javascript', 'typescript', 'dart', 'java', 'kotlin'],
    },
    {
        id: 'onesignal',
        name: 'OneSignal',
        category: 'push',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]react-native-onesignal['"]/,
            /(?:from|import|require)\s*\(?\s*['"]onesignal-(?:cordova-plugin|ngx|node)['"]/,
            /\bimport\s+OneSignalFramework\b/,                              // Swift
            /\bimport\s+com\.onesignal\b/,                                  // Android
            /\bimport\s+['"]package:onesignal_flutter\//,
        ],
        languages: ['javascript', 'typescript', 'swift', 'java', 'kotlin', 'dart'],
    },
    {
        id: 'revenuecat',
        name: 'RevenueCat',
        category: 'payments',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]react-native-purchases['"]/,
            /(?:from|import|require)\s*\(?\s*['"]@revenuecat\/purchases-js['"]/,
            /\bimport\s+RevenueCat\b/,                                      // Swift
            /\bimport\s+Purchases\b/,                                       // Swift (legacy)
            /\bimport\s+com\.revenuecat\.purchases\b/,                      // Android
            /\bimport\s+['"]package:purchases_flutter\//,
        ],
        languages: ['javascript', 'typescript', 'swift', 'java', 'kotlin', 'dart'],
    },
    {
        id: 'admob',
        name: 'Google AdMob',
        category: 'ads',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]react-native-google-mobile-ads['"]/,
            /(?:from|import|require)\s*\(?\s*['"]@react-native-firebase\/admob['"]/,
            /\bimport\s+GoogleMobileAds\b/,                                 // Swift
            /\bimport\s+com\.google\.android\.gms\.ads\b/,                  // Android
            /\bimport\s+['"]package:google_mobile_ads\//,
        ],
        languages: ['javascript', 'typescript', 'swift', 'java', 'kotlin', 'dart'],
    },
    {
        id: 'branch',
        name: 'Branch',
        category: 'attribution',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]react-native-branch['"]/,
            /\bimport\s+BranchSDK\b/,                                       // Swift
            /\bimport\s+io\.branch\.referral\b/,                            // Android
            /\bimport\s+['"]package:flutter_branch_sdk\//,
        ],
        languages: ['javascript', 'typescript', 'swift', 'java', 'kotlin', 'dart'],
    },
    {
        id: 'crashlytics',
        name: 'Firebase Crashlytics',
        category: 'crash',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]@react-native-firebase\/crashlytics['"]/,
            /\bimport\s+FirebaseCrashlytics\b/,                             // Swift
            /\bimport\s+com\.google\.firebase\.crashlytics\b/,              // Android
            /\bimport\s+['"]package:firebase_crashlytics\//,
        ],
        languages: ['javascript', 'typescript', 'swift', 'java', 'kotlin', 'dart'],
    },
    {
        id: 'google-analytics',
        name: 'Google Analytics',
        category: 'analytics',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]react-ga['"]/,
            /(?:from|import|require)\s*\(?\s*['"]@react-native-firebase\/analytics['"]/,
            /\bimport\s+FirebaseAnalytics\b/,                               // Swift
            /\bimport\s+com\.google\.firebase\.analytics\b/,                // Android
            /\bimport\s+['"]package:firebase_analytics\//,
            /\bgtag\s*\(/,                                                  // gtag.js inline
        ],
        languages: ['javascript', 'typescript', 'swift', 'java', 'kotlin', 'dart'],
    },
    // AI / LLM providers — common across the modern stack and the
    // user-named example for the multi-repo "Shared" lane.
    {
        id: 'openai',
        name: 'OpenAI',
        category: 'ai',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]openai['"]/,                // Node SDK
            /\bimport\s+openai\b/,                                            // Python
            /\bfrom\s+openai\s+import\b/,                                     // Python `from openai import ...`
            /github\.com\/sashabaranov\/go-openai/,                           // Go
            /\bimport\s+com\.theokanning\.openai\b/,                          // Java/Kotlin (community SDK)
            /\bimport\s+OpenAI\b/,                                            // Swift (MacPaw/OpenAI)
            /api\.openai\.com/,                                               // raw HTTP call (last-resort signal)
        ],
        languages: ['javascript', 'typescript', 'python', 'go', 'java', 'kotlin', 'swift'],
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        category: 'ai',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]@anthropic-ai\/sdk['"]/,    // Node SDK
            /(?:from|import|require)\s*\(?\s*['"]anthropic['"]/,
            /\bimport\s+anthropic\b/,                                          // Python
            /\bfrom\s+anthropic\s+import\b/,
            /api\.anthropic\.com/,
        ],
        languages: ['javascript', 'typescript', 'python'],
    },
    // Comms — messaging, mail, voice.
    {
        id: 'twilio',
        name: 'Twilio',
        category: 'comms',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]twilio['"]/,
            /\bimport\s+twilio\b/,                                            // Python
            /\bfrom\s+twilio\.rest\s+import\b/,
            /\bimport\s+com\.twilio\b/,                                       // Java / Kotlin
            /\busing\s+Twilio\b/,                                             // .NET
            /github\.com\/twilio\/twilio-go/,                                 // Go
            /api\.twilio\.com/,
        ],
        languages: ['javascript', 'typescript', 'python', 'java', 'kotlin', 'csharp', 'go'],
    },
    {
        id: 'sendgrid',
        name: 'SendGrid',
        category: 'comms',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]@sendgrid\/(?:mail|client)['"]/,
            /(?:from|import|require)\s*\(?\s*['"]sendgrid['"]/,
            /\bimport\s+sendgrid\b/,                                          // Python
            /\bfrom\s+sendgrid\s+import\b/,
            /\bimport\s+com\.sendgrid\b/,                                     // Java / Kotlin
            /api\.sendgrid\.com/,
        ],
        languages: ['javascript', 'typescript', 'python', 'java', 'kotlin'],
    },
    {
        id: 'slack',
        name: 'Slack',
        category: 'comms',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]@slack\/(?:web-api|bolt|webhook|events-api|interactive-messages)['"]/,
            /\bfrom\s+slack_sdk(?:\.\w+)?\s+import\b/,                         // Python (slack-sdk)
            /\bimport\s+slack_sdk\b/,
            /\bimport\s+com\.slack\b/,
            /hooks\.slack\.com\/services/,
        ],
        languages: ['javascript', 'typescript', 'python', 'java', 'kotlin'],
    },
    // Object storage providers — frequently shared between sibling repos.
    {
        id: 'aws-s3',
        name: 'AWS S3',
        category: 'storage',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]@aws-sdk\/client-s3['"]/,
            /(?:from|import|require)\s*\(?\s*['"]aws-sdk['"]/,                // v2 SDK
            /\bfrom\s+boto3\s+import\b/,                                       // Python boto3
            /\bimport\s+boto3\b/,
            /\bimport\s+software\.amazon\.awssdk\.services\.s3\b/,             // Java v2
            /\bimport\s+com\.amazonaws\.services\.s3\b/,                       // Java v1
            /github\.com\/aws\/aws-sdk-go(?:-v2)?\/service\/s3/,
        ],
        languages: ['javascript', 'typescript', 'python', 'java', 'kotlin', 'go'],
    },
    {
        id: 'gcs',
        name: 'Google Cloud Storage',
        category: 'storage',
        importPatterns: [
            /(?:from|import|require)\s*\(?\s*['"]@google-cloud\/storage['"]/,
            /\bfrom\s+google\.cloud\s+import\s+storage\b/,
            /\bimport\s+com\.google\.cloud\.storage\b/,
            /cloud\.google\.com\/go\/storage/,
        ],
        languages: ['javascript', 'typescript', 'python', 'java', 'kotlin', 'go'],
    },
];

/**
 * Read the content of a file via its FileRecord, falling back to a
 * caller-supplied content provider when content has been lazy-dropped
 * post-save (see `lazy FileRecord.content` memory note).
 */
type ContentProvider = (filePath: string) => string | undefined;
function readContent(record: FileRecord | undefined, filePath: string, getContent?: ContentProvider): string {
    if (record && typeof record.content === 'string' && record.content.length > 0) {
        return record.content;
    }
    if (getContent) {
        const c = getContent(filePath);
        if (typeof c === 'string') return c;
    }
    return '';
}

/**
 * Detect SDKs imported anywhere in a service's files.
 *
 * Returns one `SdkDependency` per matched SDK, in catalog order.
 * Empty array if no SDKs are detected (the common case for pure-backend
 * services — note: `detectSdks` does NOT itself check the service's
 * `category` field; callers gate on `category === 'frontend' | 'mobile'`
 * to avoid running this on backend services).
 *
 * The `matchedFiles` field is capped at 5 entries per SDK to keep
 * snapshots compact. Downstream L1 rendering only needs presence, not
 * a full file list.
 */
export function detectSdks(
    serviceFiles: Record<string, FileRecord>,
    fileLanguageMap: Record<string, SupportedLanguage>,
    getContent?: ContentProvider,
): SdkDependency[] {
    const matches = new Map<string, { name: string; category: SdkCategory; files: string[] }>();

    // Group files by language so we can apply the per-rule language
    // filter cheaply (one regex test per file per applicable rule).
    const filesByLang = new Map<SupportedLanguage, Array<[string, FileRecord]>>();
    for (const [fp, rec] of Object.entries(serviceFiles)) {
        const lang = fileLanguageMap[fp];
        if (!lang) continue;
        let bucket = filesByLang.get(lang);
        if (!bucket) {
            bucket = [];
            filesByLang.set(lang, bucket);
        }
        bucket.push([fp, rec]);
    }

    for (const rule of SDK_CATALOG) {
        const applicableBuckets = rule.languages
            .map((l) => filesByLang.get(l))
            .filter((b): b is Array<[string, FileRecord]> => Array.isArray(b) && b.length > 0);
        if (applicableBuckets.length === 0) continue;

        outer: for (const bucket of applicableBuckets) {
            for (const [fp, rec] of bucket) {
                const content = readContent(rec, fp, getContent);
                if (content.length === 0) continue;
                for (const pat of rule.importPatterns) {
                    if (pat.test(content)) {
                        let entry = matches.get(rule.id);
                        if (!entry) {
                            entry = { name: rule.name, category: rule.category, files: [] };
                            matches.set(rule.id, entry);
                        }
                        if (entry.files.length < 5 && !entry.files.includes(fp)) {
                            entry.files.push(fp);
                        }
                        // Don't break — keep accumulating up to the 5-file cap.
                        break;
                    }
                }
                if (matches.get(rule.id)?.files.length === 5) break outer;
            }
        }
    }

    const result: SdkDependency[] = [];
    for (const rule of SDK_CATALOG) {
        const m = matches.get(rule.id);
        if (m) {
            result.push({ sdkId: rule.id, name: m.name, category: m.category, matchedFiles: m.files });
        }
    }
    return result;
}
