/**
 * Tier 1 (Issue 364 — Same TS file parsed up to 5× per save) — regression tests for non-API entry points that the
 * pipeline now surfaces as L2b sub-sections: background jobs, message-queue
 * consumers, CLI commands, controller filters, DB migrations, DB seeds.
 *
 * Each test uses a tiny synthetic source so failures point straight at the
 * specific regex / pattern shape, not at incidental side-effects of a
 * larger fixture.
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';

describe('Tier 1 — Background jobs (JOB)', () => {
    it('JS: Bull / BullMQ Worker emits a JOB record', () => {
        const src = `
import { Worker } from 'bullmq';
const w = new Worker('email-queue', async (job) => {
    await sendEmail(job.data);
});
`;
        const apis = detectFrameworkApis(src, 'src/queues/emailWorker.ts', 'typescript');
        const job = apis.find(a => a.method === 'JOB');
        expect(job).toBeDefined();
        expect(job?.route).toBe('/queue:email-queue');
    });

    it('JS: Bull queue.process emits a JOB record', () => {
        const src = `
import Bull from 'bull';
const queue = new Bull('reports');
queue.process('generate', async (job) => { /* ... */ });
`;
        const apis = detectFrameworkApis(src, 'src/jobs.js', 'javascript');
        expect(apis.some(a => a.method === 'JOB')).toBe(true);
    });

    it('NestJS: @Process decorator emits a JOB record', () => {
        const src = `
import { Process, Processor } from '@nestjs/bull';
@Processor('audio')
export class AudioConsumer {
    @Process('transcode')
    async handleTranscode(job) { /* ... */ }
}
`;
        const apis = detectFrameworkApis(src, 'src/audio.consumer.ts', 'typescript');
        expect(apis.some(a => a.method === 'JOB' && a.route === '/job:transcode')).toBe(true);
    });

    it('Python: Celery @shared_task emits a JOB record', () => {
        const src = `
from celery import shared_task

@shared_task
def add(x, y):
    return x + y
`;
        const apis = detectFrameworkApis(src, 'app/tasks.py', 'python');
        const job = apis.find(a => a.method === 'JOB');
        expect(job).toBeDefined();
        expect(job?.handlerName).toBe('add');
    });

    it('Python: Celery @app.task emits a JOB record', () => {
        const src = `
from celery import Celery
app = Celery('proj')

@app.task(bind=True)
def slow_add(self, x, y):
    return x + y
`;
        const apis = detectFrameworkApis(src, 'app/tasks.py', 'python');
        expect(apis.some(a => a.method === 'JOB' && a.handlerName === 'slow_add')).toBe(true);
    });

    it('Java/Spring: @Scheduled emits a JOB record', () => {
        const src = `
import org.springframework.scheduling.annotation.Scheduled;

public class ReportJob {
    @Scheduled(cron = "0 0 * * * *")
    public void generateHourlyReport() { /* ... */ }
}
`;
        const apis = detectFrameworkApis(src, 'src/main/java/com/example/ReportJob.java', 'java');
        const job = apis.find(a => a.method === 'JOB');
        expect(job).toBeDefined();
        expect(job?.route).toMatch(/^\/cron:/);
    });

    it('PHP/Laravel: ShouldQueue emits a JOB record', () => {
        const src = `<?php
namespace App\\Jobs;
use Illuminate\\Contracts\\Queue\\ShouldQueue;

class ProcessPodcast implements ShouldQueue
{
    public function handle() { /* ... */ }
}
`;
        const apis = detectFrameworkApis(src, 'app/Jobs/ProcessPodcast.php', 'php');
        const job = apis.find(a => a.method === 'JOB');
        expect(job).toBeDefined();
        expect(job?.handlerName).toBe('ProcessPodcast');
    });

    it('Ruby: Sidekiq worker emits a JOB record', () => {
        const src = `
class HardWorker
  include Sidekiq::Worker
  def perform(name, count)
    puts "Doing hard work"
  end
end
`;
        const apis = detectFrameworkApis(src, 'app/workers/hard_worker.rb', 'ruby');
        const job = apis.find(a => a.method === 'JOB');
        expect(job).toBeDefined();
        expect(job?.route).toBe('/sidekiq:HardWorker');
    });

    it('Ruby: ActiveJob emits a JOB record', () => {
        const src = `
class GuestsCleanupJob < ApplicationJob
  queue_as :default
  def perform(*guests)
    # cleanup
  end
end
`;
        const apis = detectFrameworkApis(src, 'app/jobs/guests_cleanup_job.rb', 'ruby');
        expect(apis.some(a => a.method === 'JOB' && a.route === '/activejob:GuestsCleanupJob')).toBe(true);
    });
});

describe('Tier 1 — Message-queue consumers (MQ_CONSUMER)', () => {
    it('JS: kafkajs consumer.subscribe emits MQ_CONSUMER', () => {
        const src = `
import { Kafka } from 'kafkajs';
const kafka = new Kafka({ brokers: ['localhost:9092'] });
const consumer = kafka.consumer({ groupId: 'test' });
await consumer.subscribe({ topic: 'orders', fromBeginning: true });
`;
        const apis = detectFrameworkApis(src, 'src/consumer.ts', 'typescript');
        expect(apis.some(a => a.method === 'MQ_CONSUMER' && a.route === '/kafka:orders')).toBe(true);
    });

    it('JS: amqplib channel.consume emits MQ_CONSUMER', () => {
        const src = `
const amqp = require('amqplib');
const channel = await conn.createChannel();
channel.consume('jobs.process', (msg) => { /* ... */ });
`;
        const apis = detectFrameworkApis(src, 'src/amqp.js', 'javascript');
        expect(apis.some(a => a.method === 'MQ_CONSUMER' && a.route === '/amqp:jobs.process')).toBe(true);
    });

    it('Java: @KafkaListener emits MQ_CONSUMER', () => {
        const src = `
import org.springframework.kafka.annotation.KafkaListener;

public class OrderConsumer {
    @KafkaListener(topics = "orders", groupId = "order-group")
    public void onOrder(String message) { /* ... */ }
}
`;
        const apis = detectFrameworkApis(src, 'src/main/java/com/example/OrderConsumer.java', 'java');
        expect(apis.some(a => a.method === 'MQ_CONSUMER' && a.route === '/kafka:orders')).toBe(true);
    });

    it('Java: @RabbitListener emits MQ_CONSUMER', () => {
        const src = `
import org.springframework.amqp.rabbit.annotation.RabbitListener;

public class EmailConsumer {
    @RabbitListener(queues = "email.outbound")
    public void receive(String email) { /* ... */ }
}
`;
        const apis = detectFrameworkApis(src, 'src/main/java/com/example/EmailConsumer.java', 'java');
        expect(apis.some(a => a.method === 'MQ_CONSUMER' && a.route === '/rabbit:email.outbound')).toBe(true);
    });

    it('Java: @JmsListener emits MQ_CONSUMER', () => {
        const src = `
import org.springframework.jms.annotation.JmsListener;

public class JmsConsumer {
    @JmsListener(destination = "alerts")
    public void onAlert(String msg) { /* ... */ }
}
`;
        const apis = detectFrameworkApis(src, 'src/main/java/com/example/JmsConsumer.java', 'java');
        expect(apis.some(a => a.method === 'MQ_CONSUMER' && a.route === '/jms:alerts')).toBe(true);
    });
});

describe('Tier 1 — CLI commands (CLI_COMMAND)', () => {
    it('Python: Django management Command emits CLI_COMMAND', () => {
        const src = `
from django.core.management.base import BaseCommand

class Command(BaseCommand):
    help = 'Reset all user passwords'
    def handle(self, *args, **options):
        pass
`;
        const apis = detectFrameworkApis(src, 'app/management/commands/reset_passwords.py', 'python');
        const cli = apis.find(a => a.method === 'CLI_COMMAND');
        expect(cli).toBeDefined();
        expect(cli?.route).toBe('/manage:reset_passwords');
    });

    it('Python: Click @click.command emits CLI_COMMAND', () => {
        const src = `
import click

@click.command()
@click.option('--count', default=1)
def hello(count):
    click.echo(f'Hello {count}')
`;
        const apis = detectFrameworkApis(src, 'cli.py', 'python');
        expect(apis.some(a => a.method === 'CLI_COMMAND' && a.handlerName === 'hello')).toBe(true);
    });

    it('Python: Typer @app.command emits CLI_COMMAND', () => {
        const src = `
import typer
app = typer.Typer()

@app.command()
def deploy(env: str):
    typer.echo(f"Deploying to {env}")
`;
        const apis = detectFrameworkApis(src, 'cli.py', 'python');
        expect(apis.some(a => a.method === 'CLI_COMMAND' && a.handlerName === 'deploy')).toBe(true);
    });

    it('PHP/Symfony: #[AsCommand] attribute emits CLI_COMMAND', () => {
        const src = `<?php
use Symfony\\Component\\Console\\Attribute\\AsCommand;
use Symfony\\Component\\Console\\Command\\Command;

#[AsCommand(name: 'app:create-user', description: 'Creates a user')]
class CreateUserCommand extends Command
{
    protected function execute() { /* ... */ }
}
`;
        const apis = detectFrameworkApis(src, 'src/Command/CreateUserCommand.php', 'php');
        expect(apis.some(a => a.method === 'CLI_COMMAND' && a.route === '/console:app:create-user')).toBe(true);
    });

    it('PHP/Laravel: $signature emits CLI_COMMAND', () => {
        const src = `<?php
namespace App\\Console\\Commands;
use Illuminate\\Console\\Command;

class SendReports extends Command
{
    protected $signature = 'reports:send {--user=}';
    public function handle() { /* ... */ }
}
`;
        const apis = detectFrameworkApis(src, 'app/Console/Commands/SendReports.php', 'php');
        const cli = apis.find(a => a.method === 'CLI_COMMAND' && a.route?.startsWith('/artisan:'));
        expect(cli).toBeDefined();
        expect(cli?.route).toBe('/artisan:reports:send');
    });
});

describe('Tier 1 — Database lifecycle (DB_MIGRATION, DB_SEED)', () => {
    it('Ruby: Rails migration emits DB_MIGRATION', () => {
        const src = `
class CreateArticles < ActiveRecord::Migration[7.0]
  def change
    create_table :articles do |t|
      t.string :title
    end
  end
end
`;
        const apis = detectFrameworkApis(src, 'db/migrate/20240101000001_create_articles.rb', 'ruby');
        expect(apis.some(a => a.method === 'DB_MIGRATION' && a.handlerName === 'CreateArticles')).toBe(true);
    });

    it('Python: Alembic migration emits DB_MIGRATION', () => {
        const src = `
"""create_users_table"""
from alembic import op
import sqlalchemy as sa

def upgrade():
    op.create_table('users')

def downgrade():
    op.drop_table('users')
`;
        const apis = detectFrameworkApis(src, 'alembic/versions/abc123_create_users.py', 'python');
        expect(apis.some(a => a.method === 'DB_MIGRATION')).toBe(true);
    });

    it('Python: Alembic migration with upgrade+downgrade emits exactly ONE DB_MIGRATION (BUG-EXP-1 — no double-count)', () => {
        const src = `
"""create_users_table"""
from alembic import op

def upgrade():
    op.create_table('users')

def downgrade():
    op.drop_table('users')
`;
        const apis = detectFrameworkApis(src, 'alembic/versions/abc123_create_users.py', 'python');
        const migs = apis.filter(a => a.method === 'DB_MIGRATION');
        // Regression: previously BOTH def upgrade() and def downgrade() matched → 2 records
        // with identical route `migration:abc123_create_users`, inflating counts.
        expect(migs).toHaveLength(1);
        expect(migs[0].handlerName).toBe('upgrade');
        expect(migs[0].route).toBe('/migration:abc123_create_users');
    });

    it('TS: TypeORM MigrationInterface emits DB_MIGRATION', () => {
        const src = `
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsers1700000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> { /* ... */ }
    public async down(queryRunner: QueryRunner): Promise<void> { /* ... */ }
}
`;
        const apis = detectFrameworkApis(src, 'src/migrations/1700000000000-CreateUsers.ts', 'typescript');
        expect(apis.some(a => a.method === 'DB_MIGRATION' && a.handlerName === 'CreateUsers1700000000000')).toBe(true);
    });

    it('JS: Knex migration in migrations/ folder emits DB_MIGRATION', () => {
        const src = `
exports.up = async function(knex) {
    return knex.schema.createTable('users', t => { t.increments('id'); });
};
exports.down = async function(knex) {
    return knex.schema.dropTable('users');
};
`;
        const apis = detectFrameworkApis(src, 'db/migrations/20240101_create_users.js', 'javascript');
        expect(apis.some(a => a.method === 'DB_MIGRATION')).toBe(true);
    });

    it('TS: Prisma seed file emits DB_SEED', () => {
        const src = `
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    await prisma.user.create({ data: { email: 'a@b.c' } });
}

main();
`;
        const apis = detectFrameworkApis(src, 'prisma/seed.ts', 'typescript');
        const seed = apis.find(a => a.method === 'DB_SEED');
        expect(seed).toBeDefined();
        expect(seed?.handlerName).toBe('main');
    });

    it('Ruby: db/seeds.rb emits DB_SEED', () => {
        const src = `
User.create!(email: 'admin@example.com', password: 'secret')
Article.create!(title: 'Hello, World')
`;
        const apis = detectFrameworkApis(src, 'db/seeds.rb', 'ruby');
        expect(apis.some(a => a.method === 'DB_SEED')).toBe(true);
    });
});

describe('Tier 1 — Rails controller filters (FILTER)', () => {
    it('before_action with bang method name emits FILTER', () => {
        const src = `
class TodosController < ApplicationController
  before_action :authenticate_user!
  before_action :set_todo, only: [:show, :update]
  after_action :log_request
  around_action :wrap_in_transaction
end
`;
        const apis = detectFrameworkApis(src, 'app/controllers/todos_controller.rb', 'ruby');
        const filters = apis.filter(a => a.method === 'FILTER');
        expect(filters.length).toBe(4);
        expect(filters.map(f => f.handlerName).sort()).toEqual(
            ['authenticate_user!', 'log_request', 'set_todo', 'wrap_in_transaction'].sort(),
        );
    });

    it('before_action outside controller file is NOT detected (path-gated)', () => {
        const src = `
class MyHelper
  before_action :foo
end
`;
        const apis = detectFrameworkApis(src, 'app/helpers/my_helper.rb', 'ruby');
        expect(apis.filter(a => a.method === 'FILTER')).toHaveLength(0);
    });
});
