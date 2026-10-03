/**
 * djangoRouteBackslash.test.ts — BUG-EXP-19.
 *
 * Django `re_path(r'…')` routes were normalized with
 * `.replace(/[\^$]/g,'').replace(/\\/g,'')` — the second replace stripped
 * EVERY backslash, corrupting regex character classes: `[-\w]+`→`[-w]+`,
 * `[\d]+`→`[d]+`, `\w+`→`w+`. Only the `^`/`$` anchors should be dropped;
 * backslashes must survive.
 */
import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';

// String.raw so `\w` / `\d` reach the detector as literal backslash sequences
// (a plain JS string would collapse `\w` → `w` before the detector ever sees it).
const SRC = String.raw`
from django.urls import re_path
from . import views

urlpatterns = [
    re_path(r'^articles/(?P<article_slug>[-\w]+)/comments/(?P<comment_pk>[\d]+)/?$', views.comment_detail),
    re_path(r'^users/(?P<username>\w+)/$', views.UserView.as_view()),
]
`;

describe('BUG-EXP-19 — Django regex route backslash preservation', () => {
    const apis = detectFrameworkApis(SRC, 'app/urls.py', 'python');
    const routes = apis.map(a => String(a.route));

    it('preserves \\w in a character class ([-\\w]+ not [-w]+)', () => {
        expect(routes.some(r => r.includes('[-\\w]+'))).toBe(true);
        expect(routes.some(r => r.includes('[-w]+'))).toBe(false);
    });

    it('preserves \\d in a character class ([\\d]+ not [d]+)', () => {
        expect(routes.some(r => r.includes('[\\d]+'))).toBe(true);
        expect(routes.some(r => r.includes('[d]+'))).toBe(false);
    });

    it('preserves a bare \\w+ named group (\\w+ not w+)', () => {
        expect(routes.some(r => r.includes('(?P<username>\\w+)'))).toBe(true);
    });

    it('still strips the ^ and $ anchors', () => {
        expect(routes.every(r => !r.includes('^') && !r.includes('$'))).toBe(true);
    });
});
