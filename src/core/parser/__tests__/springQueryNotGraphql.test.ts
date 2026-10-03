/**
 * springQueryNotGraphql.test.ts — Spring Data `@Query` JPQL vs GraphQL `@Query`.
 *
 * The GraphQL plugin's line-anchored `@Query('…')` decorator (NestJS /
 * TypeGraphQL) also matched Spring Data JPA's `@Query("SELECT … FROM …")`,
 * emitting a bogus `QUERY` entry point whose route is the raw JPQL/SQL
 * (`QUERY /SELECT ptype FROM PetType …` on PetClinic). Java/Kotlin GraphQL
 * never uses the `@Query('name')` decorator form, and a SQL-shaped argument is
 * a query statement, not a GraphQL field name.
 */
import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';

const SPRING_REPO = `
package org.springframework.samples.petclinic.owner;

import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.Repository;

public interface PetTypeRepository extends Repository<PetType, Integer> {
    @Query("SELECT ptype FROM PetType ptype ORDER BY ptype.name")
    List<PetType> findPetTypes();
}
`;

const NEST_RESOLVER = `
import { Resolver, Query } from '@nestjs/graphql';

@Resolver()
export class UserResolver {
    @Query('users')
    getUsers() { return []; }
}
`;

describe('Spring Data @Query must not be a GraphQL QUERY route', () => {
    it('does NOT emit a QUERY entry point for Spring JPA @Query (JPQL)', () => {
        const apis = detectFrameworkApis(SPRING_REPO, 'owner/PetTypeRepository.java', 'java');
        expect(apis.some(a => a.method === 'QUERY')).toBe(false);
        expect(apis.some(a => String(a.route).toUpperCase().includes('SELECT'))).toBe(false);
    });

    it('STILL detects a genuine NestJS/TypeGraphQL @Query in TypeScript', () => {
        const apis = detectFrameworkApis(NEST_RESOLVER, 'user.resolver.ts', 'typescript');
        expect(apis.some(a => a.method === 'QUERY')).toBe(true);
    });
});
