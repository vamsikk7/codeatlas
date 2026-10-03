import { describe, it } from 'vitest';
import { detectFrameworkApis } from '../../src/core/parser/frameworkDetector';
describe('gql check', () => {
    it('sdl', () => {
        const sdl = `
import { gql } from 'apollo-server';
export const typeDefs = gql\`
  type Query { users: [User]! book(id: ID!): Book }
  type Mutation { addBook(title: String!): Book updateUser(id: ID!): User }
  type Subscription { bookAdded: Book }
\`;`;
        const apis = detectFrameworkApis(sdl, 'src/schema.ts', 'typescript');
        console.log('methods:', JSON.stringify(apis.map(a => a.method + ':' + a.route)));
    });
    it('resolvers', () => {
        const r = `const resolvers = { Query: { users() {}, book() {} }, Mutation: { addBook() {}, updateUser() {} }, Subscription: { bookAdded: {} } };`;
        const apis = detectFrameworkApis(r, 'src/resolvers.ts', 'typescript');
        console.log('resolver methods:', JSON.stringify(apis.map(a => a.method + ':' + a.route)));
    });
});
