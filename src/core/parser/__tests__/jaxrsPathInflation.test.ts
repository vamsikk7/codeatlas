/**
 * jaxrsPathInflation.test.ts — BUG-EXP-16.
 *
 * JAX-RS `@Path` should only produce a standalone `PATH` entry for a
 * sub-resource LOCATOR (a `@Path` method with no HTTP-method annotation).
 * `@Path` on a resource class (base prefix) or on a `@GET`/`@POST` method
 * (redundant with that method's record) must NOT inflate the entry count.
 */
import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';

const SRC = `
package com.example;
import jakarta.ws.rs.*;

@Path("/users")
public class UserResource {

    @GET
    @Path("/{id}")
    public User get(@PathParam("id") Long id) { return null; }

    @POST
    public User create(User u) { return u; }

    @Path("/{id}/comments")
    public CommentsResource comments() { return new CommentsResource(); }
}
`;

describe('BUG-EXP-16 — JAX-RS @Path inflation', () => {
    const apis = detectFrameworkApis(SRC, 'src/main/java/com/example/UserResource.java', 'java');
    const paths = apis.filter(a => a.method === 'PATH');

    it('does NOT emit a PATH record for the class-level @Path (base prefix)', () => {
        expect(paths.some(p => p.route === '/users'), 'class @Path should not be a PATH entry').toBe(false);
    });

    it('does NOT emit a PATH record for a @Path that sits on an @GET method', () => {
        expect(paths.some(p => p.route === '/{id}'), '@GET+@Path method should not add a PATH entry').toBe(false);
    });

    it('DOES emit a PATH record for a sub-resource locator (@Path, no HTTP verb)', () => {
        expect(paths.some(p => p.route === '/{id}/comments'), 'sub-resource locator is a real endpoint').toBe(true);
    });

    it('still emits the HTTP-method records (GET + POST)', () => {
        expect(apis.some(a => a.method === 'GET')).toBe(true);
        expect(apis.some(a => a.method === 'POST')).toBe(true);
    });
});
