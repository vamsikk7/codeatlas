/**
 * extractionGapFixes.test.ts — #878 (Rails before_filter) + #879 (cal.com defaultHandler)
 *
 * Real detector misses from the benchmark dry-run triage:
 *  - discourse #9: `before_filter :set_locale` (legacy Rails alias) in a
 *    controller — the detector only knew `before_action`, so the filter (and
 *    thus the controller's entry-point surface) was invisible.
 *  - cal.com #14943: `export default defaultHandler({ POST })` API handler under
 *    packages/features/ee/workflows/api/ — outside pages/api/, so the path-gated
 *    Pages-Router pattern missed it.
 */
import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';

describe('#878 — Rails legacy before_filter / after_filter aliases', () => {
    it('detects before_filter (legacy alias) in a controller as a FILTER', () => {
        const src = `
class ApplicationController < ActionController::Base
  before_filter :set_locale
  after_filter :log_request

  def set_locale
    I18n.locale = params[:locale]
  end
end
`;
        const apis = detectFrameworkApis(src, 'app/controllers/application_controller.rb', 'ruby');
        const filters = apis.filter((a) => a.method === 'FILTER').map((a) => a.handlerName).sort();
        expect(filters).toEqual(['log_request', 'set_locale']);
    });

    it('still detects the modern before_action form', () => {
        const src = `
class UsersController < ApplicationController
  before_action :authenticate
end
`;
        const apis = detectFrameworkApis(src, 'app/controllers/users_controller.rb', 'ruby');
        expect(apis.some((a) => a.method === 'FILTER' && a.handlerName === 'authenticate')).toBe(true);
    });

    it('does not fire outside *_controller.rb', () => {
        const src = `before_filter :foo`;
        const apis = detectFrameworkApis(src, 'app/models/user.rb', 'ruby');
        expect(apis.filter((a) => a.method === 'FILTER')).toHaveLength(0);
    });
});

describe('#879 — cal.com defaultHandler({ METHOD }) outside pages/api', () => {
    it('detects POST from defaultHandler under an arbitrary api/ dir', () => {
        const src = `
import { defaultHandler } from "@calcom/lib/server";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.json({ ok: true });
}

export default defaultHandler({ POST: Promise.resolve({ default: handler }) });
`;
        const apis = detectFrameworkApis(src, 'packages/features/ee/workflows/api/scheduleSMSReminders.ts', 'typescript');
        const post = apis.find((a) => a.method === 'POST' && a.handlerName === 'defaultHandler');
        expect(post).toBeDefined();
        expect(post?.route).toBe('/scheduleSMSReminders');
        expect(post?.filePath).toBe('packages/features/ee/workflows/api/scheduleSMSReminders.ts');
    });

    it('fans out multiple HTTP-method keys', () => {
        const src = `export default defaultHandler({ GET: getHandler, POST: postHandler });`;
        const apis = detectFrameworkApis(src, 'pages/api/bookings.ts', 'typescript');
        const methods = apis.filter((a) => a.handlerName === 'defaultHandler').map((a) => a.method).sort();
        expect(methods).toEqual(['GET', 'POST']);
    });

    it('does NOT match a generic defaultHandler with no HTTP-method keys', () => {
        const src = `export const x = defaultHandler({ onError: cb, retries: 3 });`;
        const apis = detectFrameworkApis(src, 'src/lib/queue.ts', 'typescript');
        expect(apis.filter((a) => a.handlerName === 'defaultHandler')).toHaveLength(0);
    });
});
