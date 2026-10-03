/**
 * middlewareTaggers/index.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Re-exports every per-framework middleware tagger so the dispatcher
 * (`frameworkDetector.ts`) can keep a single import statement. Each
 * tagger lives in its own file under this directory for finer
 * per-framework testing + isolation.
 *
 * To add a new framework: create `<framework>.ts` here, export the
 * `tag<Framework>Middleware` function (and any private helpers it
 * needs), then add a re-export line below + a dispatch line in
 * `frameworkDetector.ts`.
 */

export { tagFastApiAuthDependencies } from './fastapi';
export { tagSpringSecurityAnnotations } from './spring';
export { tagNestJsMiddleware, collectNestJsClassMiddleware } from './nestjs';
export { tagDjangoViewDecorators } from './django';
export { tagFlaskMiddleware } from './flask';
export { tagRailsControllerFilters } from './rails';
export { tagGoMiddleware, parseGoUseArgs } from './go';
export { tagLaravelMiddleware } from './laravel';
export { tagAspNetAttributes, collectAspNetAttributesBefore } from './aspnet';
export { tagRustMiddleware } from './rust';
export { tagGrpcInterceptors, parseGrpcInterceptorArgs } from './grpc';
export { tagGraphqlDirectives } from './graphql';
export { tagSymfonyAttributes, collectSymfonyAttributesBefore } from './symfony';
export { tagSinatraBeforeHooks } from './sinatra';
