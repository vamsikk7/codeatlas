/**
 * dbSchemaDetector.test.ts — coverage per ORM family.
 */

import { describe, it, expect } from 'vitest';
import { detectDbSchemas } from '../dbSchemaDetector';
import type { FileRecord } from '../../graph/graphTypes';

function file(content: string): FileRecord {
    return { path: '', hash: '', mtime: 0, content, symbols: { functions: [], variables: [], imports: [] } } as FileRecord;
}

describe('detectDbSchemas — Prisma', () => {
    it('extracts model names and reads engine from datasource', () => {
        const schema = `
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}

model Article {
  id     Int    @id @default(autoincrement())
  title  String
}
`;
        const files = { 'prisma/schema.prisma': file(schema) };
        const out = detectDbSchemas(files);
        expect(out.map(e => ({ engine: e.engine, tableName: e.tableName, source: e.source }))).toEqual([
            { engine: 'postgresql', tableName: 'user', source: 'prisma' },
            { engine: 'postgresql', tableName: 'article', source: 'prisma' },
        ]);
    });

    it('falls back to engine="unknown" when no datasource is declared', () => {
        const files = { 'schema.prisma': file('model Foo { id Int @id }') };
        const out = detectDbSchemas(files);
        expect(out[0].engine).toBe('unknown');
    });
});

describe('detectDbSchemas — TypeORM', () => {
    it('picks up @Entity("name"), @Entity({name: ...}), and bare @Entity()', () => {
        const ts = `
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('users')
export class UserA { @PrimaryGeneratedColumn() id: number; }

@Entity({ name: 'orders' })
export class OrderEntity { @PrimaryGeneratedColumn() id: number; }

@Entity()
export class Comment { @PrimaryGeneratedColumn() id: number; }
`;
        const files = { 'src/entities.ts': file(ts) };
        const out = detectDbSchemas(files);
        const names = out.map(e => e.tableName).sort();
        expect(names).toContain('users');
        expect(names).toContain('orders');
        expect(names).toContain('comment');
    });
});

describe('detectDbSchemas — Sequelize', () => {
    it('captures sequelize.define("name") and tableName: "x" inside Model class', () => {
        const ts = `
import { Sequelize, DataTypes, Model } from 'sequelize';
const sequelize = new Sequelize(...);

const User = sequelize.define('users', { id: { type: DataTypes.INTEGER } });

class Article extends Model {}
Article.init({ id: DataTypes.INTEGER }, { sequelize, tableName: 'articles' });
`;
        const files = { 'src/models.ts': file(ts) };
        const out = detectDbSchemas(files);
        const names = out.map(e => e.tableName).sort();
        expect(names).toContain('users');
        expect(names).toContain('articles');
    });
});

describe('detectDbSchemas — Mongoose', () => {
    it('extracts collection name from mongoose.model("Name", schema)', () => {
        const ts = `
import mongoose from 'mongoose';
const userSchema = new mongoose.Schema({ name: String });
export const User = mongoose.model('User', userSchema);
`;
        const files = { 'src/user.ts': file(ts) };
        const out = detectDbSchemas(files);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            engine: 'mongodb', tableName: 'user', source: 'mongoose',
        });
    });
});

describe('detectDbSchemas — SQLAlchemy', () => {
    it('captures __tablename__ assignments', () => {
        const py = `
from sqlalchemy.orm import declarative_base

Base = declarative_base()
class User(Base):
    __tablename__ = 'users'
    id = Column(Integer, primary_key=True)
`;
        const files = { 'app/models/user.py': file(py) };
        const out = detectDbSchemas(files);
        expect(out[0]).toMatchObject({ tableName: 'users', source: 'sqlalchemy' });
    });
});

describe('detectDbSchemas — Django', () => {
    it('prefers db_table when set', () => {
        const py = `
from django.db import models

class User(models.Model):
    name = models.CharField(max_length=100)
    class Meta:
        db_table = 'auth_users'
`;
        const files = { 'app/models.py': file(py) };
        const out = detectDbSchemas(files);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ tableName: 'auth_users', source: 'django' });
    });

    it('falls back to class name when db_table is absent', () => {
        const py = `
from django.db import models
class Article(models.Model):
    title = models.CharField(max_length=100)
`;
        const files = { 'app/models.py': file(py) };
        const out = detectDbSchemas(files);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ tableName: 'article', source: 'django' });
    });
});

describe('detectDbSchemas — Rails migrations', () => {
    it('picks up create_table :name from db/migrate', () => {
        const rb = `
class CreateUsers < ActiveRecord::Migration[7.0]
  def change
    create_table :users do |t|
      t.string :email
      t.timestamps
    end
  end
end
`;
        const files = { 'db/migrate/20230101_create_users.rb': file(rb) };
        const out = detectDbSchemas(files);
        expect(out[0]).toMatchObject({ tableName: 'users', source: 'rails' });
    });

    it('ignores create_table outside db/migrate or schema.rb', () => {
        const rb = "puts 'create_table :random_string_in_test'";
        const files = { 'spec/foo_spec.rb': file(rb) };
        const out = detectDbSchemas(files);
        expect(out).toEqual([]);
    });
});

describe('detectDbSchemas — GORM', () => {
    it('prefers TableName() return value', () => {
        const go = `
package model

type User struct {
    ID uint \`gorm:"primaryKey"\`
}

func (User) TableName() string { return "users" }
`;
        const files = { 'pkg/model/user.go': file(go) };
        const out = detectDbSchemas(files);
        expect(out[0]).toMatchObject({ tableName: 'users', source: 'gorm' });
    });

    it('falls back to struct name when TableName() is absent', () => {
        const go = `
type Article struct {
    ID    uint   \`gorm:"primaryKey"\`
    Title string \`gorm:"index"\`
}
`;
        const files = { 'pkg/model/article.go': file(go) };
        const out = detectDbSchemas(files);
        expect(out[0]).toMatchObject({ tableName: 'article', source: 'gorm' });
    });
});

describe('detectDbSchemas — misc', () => {
    it('returns empty for files with no ORM signal', () => {
        const ts = "export function hello() { return 'world'; }";
        const files = { 'src/util.ts': file(ts) };
        expect(detectDbSchemas(files)).toEqual([]);
    });

    it('deduplicates same-key entries within a single service', () => {
        const ts = `
import mongoose from 'mongoose';
const a = mongoose.model('User', s1);
const b = mongoose.model('User', s2);
`;
        const out = detectDbSchemas({ 'src/x.ts': file(ts) });
        expect(out).toHaveLength(1);
        expect(out[0].tableName).toBe('user');
    });
});
