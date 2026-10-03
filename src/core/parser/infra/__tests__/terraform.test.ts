/**
 * terraform.test.ts — Issue #705 Phase 1.
 */

import { describe, it, expect } from 'vitest';
import { canParseTerraform, parseTerraform } from '../terraform';

describe('canParseTerraform', () => {
    it('matches .tf + .tf.json', () => {
        expect(canParseTerraform('main.tf')).toBe(true);
        expect(canParseTerraform('infra/lambda.tf')).toBe(true);
        expect(canParseTerraform('overrides.tf.json')).toBe(true);
    });
    it('rejects unrelated files', () => {
        expect(canParseTerraform('main.go')).toBe(false);
        expect(canParseTerraform('terraform.lock.hcl')).toBe(false);
    });
});

describe('parseTerraform', () => {
    it('returns no records for an empty / commented file', () => {
        expect(parseTerraform('main.tf', '')).toEqual([]);
        expect(parseTerraform('main.tf', '# top-level comment\n')).toEqual([]);
    });

    it('extracts a single resource block', () => {
        const src = `
resource "aws_lambda_function" "handler" {
  function_name = "my-handler"
  runtime       = "nodejs20.x"
}
`;
        const records = parseTerraform('main.tf', src);
        expect(records).toHaveLength(1);
        expect(records[0].kind).toBe('terraform-resource');
        expect(records[0].name).toBe('aws_lambda_function.handler');
        expect(records[0].meta?.provider).toBe('aws');
        expect(records[0].meta?.resourceType).toBe('aws_lambda_function');
    });

    it('extracts module blocks', () => {
        const src = `
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"
}
`;
        const records = parseTerraform('main.tf', src);
        expect(records).toHaveLength(1);
        expect(records[0].kind).toBe('terraform-module');
        expect(records[0].name).toBe('module.vpc');
    });

    it('resolves resource→resource dependencies via HCL interpolation', () => {
        const src = `
resource "aws_iam_role" "lambda_exec" {
  name = "lambda-exec"
}

resource "aws_lambda_function" "handler" {
  function_name = "handler"
  role          = aws_iam_role.lambda_exec.arn
  runtime       = "nodejs20.x"
}
`;
        const records = parseTerraform('main.tf', src);
        const lambda = records.find(r => r.name === 'aws_lambda_function.handler')!;
        expect(lambda.dependencies).toContain('infra:terraform-resource:main.tf::aws_iam_role.lambda_exec');
    });

    it('resolves resource→module dependencies', () => {
        const src = `
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
}

resource "aws_lambda_function" "handler" {
  subnet_ids = module.vpc.private_subnet_ids
}
`;
        const records = parseTerraform('main.tf', src);
        const lambda = records.find(r => r.name === 'aws_lambda_function.handler')!;
        expect(lambda.dependencies).toContain('infra:terraform-module:main.tf::vpc');
    });

    it('does not emit data sources as records (but they remain reference targets)', () => {
        const src = `
data "aws_caller_identity" "current" {}

resource "aws_lambda_function" "handler" {
  account_id = data.aws_caller_identity.current.account_id
}
`;
        const records = parseTerraform('main.tf', src);
        expect(records.map(r => r.name)).toEqual(['aws_lambda_function.handler']);
        const lambda = records[0];
        // Data source references show up in the dependency list as
        // their raw address string (not a record id) so renderers can
        // still draw the edge.
        expect(lambda.dependencies).toContain('data.aws_caller_identity.current');
    });

    it('does not create a self-loop when a resource references itself', () => {
        const src = `
resource "aws_iam_role" "lambda_exec" {
  name = "lambda-exec"
  # Self-reference inside a heredoc / policy block.
  description = "Used by aws_iam_role.lambda_exec policies."
}
`;
        const records = parseTerraform('main.tf', src);
        expect(records).toHaveLength(1);
        // The dependency filter drops the self-reference.
        expect(records[0].dependencies).toBeUndefined();
    });
});
