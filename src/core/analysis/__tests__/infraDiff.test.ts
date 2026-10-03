import { describe, it, expect } from 'vitest';
import { diffInfrastructureServices } from '../serviceDetector';
import type { Snapshot, ServiceRecord, InfrastructureService } from '../../graph/graphTypes';

function makeSnapshot(files: Record<string, { hash: string; content: string }>): Snapshot {
    return {
        files: Object.fromEntries(
            Object.entries(files).map(([p, f]) => [p, { path: p, hash: f.hash, mtime: 0, content: f.content, symbols: { functions: [], variables: [], imports: [] } }])
        ),
        apiIndex: {},
        graphs: {},
    };
}

const MONGOOSE_MODEL = `
const mongoose = require('mongoose');
const userSchema = new mongoose.Schema({ email: String, name: String });
module.exports = mongoose.model('User', userSchema);
`;

const MONGOOSE_MODEL_CHANGED = `
const mongoose = require('mongoose');
const userSchema = new mongoose.Schema({ email: String, name: String, age: Number });
module.exports = mongoose.model('User', userSchema);
`;

const REDIS_SERVICE = `
const redis = require('redis');
const client = redis.createClient();
async function setSession(id) { await client.set('session:' + id, JSON.stringify({})); }
async function getSession(id) { return client.get('session:' + id); }
`;

const REDIS_KEY_CHANGED = `
const redis = require('redis');
const client = redis.createClient();
async function setSession(id) { await client.set('user:session:' + id, JSON.stringify({})); }
async function getSession(id) { return client.get('user:session:' + id); }
`;

const backendService: ServiceRecord = {
    id: 'service:backend', name: 'backend', rootPath: 'backend',
    technology: 'express', exposedApiCount: 5,
    consumedUrls: [], consumedServices: [], diff: 'unchanged',
};

describe('diffInfrastructureServices', () => {
    it('marks DB infra modified when a Mongoose schema file changes', () => {
        const baseline = makeSnapshot({ 'backend/userModel.js': { hash: 'aaa', content: MONGOOSE_MODEL } });
        const working = makeSnapshot({ 'backend/userModel.js': { hash: 'bbb', content: MONGOOSE_MODEL_CHANGED } });
        const services = { 'service:backend': backendService };

        const baselineInfra: InfrastructureService[] = [
            { id: 'infra:mongodb', name: 'MongoDB', kind: 'database', consumedBy: ['service:backend'] }
        ];
        const workingInfra: InfrastructureService[] = [
            { id: 'infra:mongodb', name: 'MongoDB', kind: 'database', consumedBy: ['service:backend'] }
        ];

        const result = diffInfrastructureServices(baselineInfra, workingInfra, baseline, working, services);
        expect(result[0].diff).toBe('modified');
    });

    it('marks cache infra modified when Redis key patterns change', () => {
        const baseline = makeSnapshot({ 'backend/session.js': { hash: 'aaa', content: REDIS_SERVICE } });
        const working = makeSnapshot({ 'backend/session.js': { hash: 'bbb', content: REDIS_KEY_CHANGED } });
        const services = { 'service:backend': backendService };

        const baselineInfra: InfrastructureService[] = [
            { id: 'infra:redis', name: 'Redis', kind: 'cache', consumedBy: ['service:backend'] }
        ];
        const workingInfra: InfrastructureService[] = [
            { id: 'infra:redis', name: 'Redis', kind: 'cache', consumedBy: ['service:backend'] }
        ];

        const result = diffInfrastructureServices(baselineInfra, workingInfra, baseline, working, services);
        expect(result[0].diff).toBe('modified');
    });

    it('marks new infra as added', () => {
        const snapshot = makeSnapshot({ 'backend/db.js': { hash: 'aaa', content: 'const pg = require("pg"); new pg.Pool({});' } });
        const services = { 'service:backend': backendService };

        const baselineInfra: InfrastructureService[] = [];
        const workingInfra: InfrastructureService[] = [
            { id: 'infra:postgresql', name: 'PostgreSQL', kind: 'database', consumedBy: ['service:backend'] }
        ];

        const result = diffInfrastructureServices(baselineInfra, workingInfra, snapshot, snapshot, services);
        expect(result[0].diff).toBe('added');
    });

    it('marks removed infra as deleted', () => {
        const snapshot = makeSnapshot({});
        const services = { 'service:backend': backendService };

        const baselineInfra: InfrastructureService[] = [
            { id: 'infra:redis', name: 'Redis', kind: 'cache', consumedBy: ['service:backend'] }
        ];
        const workingInfra: InfrastructureService[] = [];

        const result = diffInfrastructureServices(baselineInfra, workingInfra, snapshot, snapshot, services);
        expect(result[0].diff).toBe('deleted');
    });

    it('leaves unchanged infra with diff=unchanged', () => {
        const content = 'mongoose.connect(process.env.MONGODB_URI)';
        const baseline = makeSnapshot({ 'backend/db.js': { hash: 'aaa', content } });
        const working = makeSnapshot({ 'backend/db.js': { hash: 'aaa', content } });
        const services = { 'service:backend': backendService };

        const infraList: InfrastructureService[] = [
            { id: 'infra:mongodb', name: 'MongoDB', kind: 'database', consumedBy: ['service:backend'] }
        ];

        const result = diffInfrastructureServices(infraList, infraList, baseline, working, services);
        expect(result[0].diff).toBe('unchanged');
    });
});
