/**
 * Tier 2 (Issue 365 — Cascade rebuilds every api-list when one file changes) — regression tests for the second wave of non-API
 * entry points: Socket.IO event handlers, ORM lifecycle hooks (Mongoose,
 * TypeORM, Sequelize, SQLAlchemy, Rails AR callbacks), NestJS health
 * checks, plus mobile push handlers and background tasks.
 *
 * Same shape as `tier1EntryPoints.test.ts` — tiny synthetic source per
 * test so failures pin down to a specific regex.
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';
import { detectMobileItems } from '../mobileDetector';

describe('Tier 2 — Real-time (SOCKET_EVENT)', () => {
    it('Socket.IO `io.on("connection")` emits SOCKET_EVENT', () => {
        const src = `
const { Server } = require('socket.io');
const io = new Server(server);
io.on('connection', (socket) => {
    socket.on('chat-message', (msg) => { /* ... */ });
});
`;
        const apis = detectFrameworkApis(src, 'src/server.js', 'javascript');
        const events = apis.filter(a => a.method === 'SOCKET_EVENT');
        expect(events.length).toBeGreaterThanOrEqual(2);
        expect(events.some(e => e.route === '/socket:connection')).toBe(true);
        expect(events.some(e => e.route === '/socket:chat-message')).toBe(true);
    });

    it('non-socket.io `.on(...)` does not emit SOCKET_EVENT (no socket.io import)', () => {
        const src = `
const emitter = new EventEmitter();
emitter.on('something', () => {});
`;
        const apis = detectFrameworkApis(src, 'src/events.js', 'javascript');
        expect(apis.some(a => a.method === 'SOCKET_EVENT')).toBe(false);
    });
});

describe('Tier 2 — ORM lifecycle hooks (MODEL_HOOK)', () => {
    it('Mongoose `schema.pre("save", fn)` emits MODEL_HOOK', () => {
        const src = `
const mongoose = require('mongoose');
const userSchema = new mongoose.Schema({ name: String });
userSchema.pre('save', function(next) { next(); });
userSchema.post('save', function(doc) { console.log(doc); });
`;
        const apis = detectFrameworkApis(src, 'src/models/user.js', 'javascript');
        const hooks = apis.filter(a => a.method === 'MODEL_HOOK');
        expect(hooks.length).toBeGreaterThanOrEqual(2);
        expect(hooks.some(h => h.route === '/pre:save')).toBe(true);
        expect(hooks.some(h => h.route === '/post:save')).toBe(true);
    });

    it('TypeORM `@BeforeInsert()` emits MODEL_HOOK', () => {
        const src = `
import { Entity, BeforeInsert, AfterUpdate } from 'typeorm';

@Entity()
export class User {
    @BeforeInsert()
    hashPassword() { /* ... */ }

    @AfterUpdate()
    logUpdate() { /* ... */ }
}
`;
        const apis = detectFrameworkApis(src, 'src/entities/User.ts', 'typescript');
        const hooks = apis.filter(a => a.method === 'MODEL_HOOK');
        expect(hooks.length).toBe(2);
        expect(hooks.some(h => h.handlerName === 'hashPassword')).toBe(true);
        expect(hooks.some(h => h.handlerName === 'logUpdate')).toBe(true);
    });

    it('Sequelize `Model.addHook("beforeCreate", fn)` emits MODEL_HOOK', () => {
        const src = `
const { Sequelize, DataTypes } = require('sequelize');
const User = sequelize.define('User', {});
User.addHook('beforeCreate', (user) => { /* hash password */ });
`;
        const apis = detectFrameworkApis(src, 'src/models/user.js', 'javascript');
        expect(apis.some(a => a.method === 'MODEL_HOOK' && a.route === '/sequelize:beforeCreate')).toBe(true);
    });

    it('SQLAlchemy `event.listen(target, "before_insert", fn)` emits MODEL_HOOK', () => {
        const src = `
from sqlalchemy import event
from .models import User

def stamp_created_at(mapper, connection, target):
    target.created_at = datetime.utcnow()

event.listen(User, 'before_insert', stamp_created_at)
`;
        const apis = detectFrameworkApis(src, 'app/models.py', 'python');
        expect(apis.some(a => a.method === 'MODEL_HOOK' && a.handlerName === 'stamp_created_at')).toBe(true);
    });

    it('SQLAlchemy `@event.listens_for(...)` decorator emits MODEL_HOOK', () => {
        const src = `
from sqlalchemy import event
from .models import User

@event.listens_for(User, 'after_update')
def log_update(mapper, connection, target):
    pass
`;
        const apis = detectFrameworkApis(src, 'app/models.py', 'python');
        const hook = apis.find(a => a.method === 'MODEL_HOOK');
        expect(hook).toBeDefined();
        expect(hook?.handlerName).toBe('log_update');
    });

    it('Rails AR callback `before_save :foo` emits MODEL_HOOK (path-gated)', () => {
        const src = `
class Article < ApplicationRecord
  before_save :downcase_title
  after_create :send_notification
  before_destroy :archive!
end
`;
        const apis = detectFrameworkApis(src, 'app/models/article.rb', 'ruby');
        const hooks = apis.filter(a => a.method === 'MODEL_HOOK');
        expect(hooks.length).toBe(3);
        expect(hooks.map(h => h.handlerName).sort()).toEqual(['archive!', 'downcase_title', 'send_notification']);
    });

    it('Rails AR callback outside app/models/ is NOT detected', () => {
        const src = `
module Foo
  before_save :whatever
end
`;
        const apis = detectFrameworkApis(src, 'app/concerns/foo.rb', 'ruby');
        expect(apis.filter(a => a.method === 'MODEL_HOOK')).toHaveLength(0);
    });
});

describe('Tier 2 — Health endpoints (HEALTH)', () => {
    it('NestJS `@HealthCheck()` emits HEALTH', () => {
        const src = `
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

@Controller('health')
export class HealthController {
    @Get()
    @HealthCheck()
    check() { return this.health.check([]); }
}
`;
        const apis = detectFrameworkApis(src, 'src/health/health.controller.ts', 'typescript');
        expect(apis.some(a => a.method === 'HEALTH' && a.handlerName === 'check')).toBe(true);
    });
});

describe('Tier 2 — Webhook intent tagging (Issue 368)', () => {
    it('tags Stripe webhook routes via stripe.webhooks.constructEvent', () => {
        const src = `
import express from 'express';
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET);
const app = express();

app.post('/webhooks/stripe', (req, res) => {
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    res.json({ received: true });
});
`;
        const apis = detectFrameworkApis(src, 'src/webhooks.ts', 'typescript');
        const wh = apis.find(a => a.route === '/webhooks/stripe');
        expect(wh?.meta?.webhook).toBe(true);
        expect(wh?.meta?.webhookProvider).toBe('stripe');
    });

    it('tags GitHub webhook routes via x-hub-signature-256 header check', () => {
        const src = `
const express = require('express');
const app = express();

app.post('/webhooks/github', (req, res) => {
    const sig = req.headers['x-hub-signature-256'];
    if (!verifyWebhookSignature(req.body, sig)) return res.status(401).end();
    res.json({});
});
`;
        const apis = detectFrameworkApis(src, 'src/webhooks.js', 'javascript');
        const wh = apis.find(a => a.route === '/webhooks/github');
        expect(wh?.meta?.webhook).toBe(true);
        expect(wh?.meta?.webhookProvider).toBe('github');
    });

    it('does not tag GET / non-mutating routes as webhooks even when keywords nearby', () => {
        const src = `
const express = require('express');
const app = express();

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
app.get('/health', (req, res) => res.json({ ok: true }));
`;
        const apis = detectFrameworkApis(src, 'src/server.js', 'javascript');
        const health = apis.find(a => a.route === '/health');
        expect(health?.method).toBe('GET');
        expect(health?.meta?.webhook).toBeUndefined();
    });
});

describe('Tier 2 — Mobile push handlers (PUSH_HANDLER)', () => {
    it('Android FirebaseMessagingService.onMessageReceived emits PUSH_HANDLER', () => {
        const src = `
package com.example.fcm

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class MyFcmService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) { }
    override fun onNewToken(token: String) { }
}
`;
        const items = detectMobileItems(src, 'app/src/main/kotlin/MyFcmService.kt', 'kotlin');
        const handlers = items.filter(i => i.method === 'PUSH_HANDLER');
        expect(handlers.length).toBe(2);
        expect(handlers.some(h => h.handlerName === 'onMessageReceived')).toBe(true);
        expect(handlers.some(h => h.handlerName === 'onNewToken')).toBe(true);
    });

    it('iOS UNUserNotificationCenterDelegate emits PUSH_HANDLER', () => {
        const src = `
import UIKit
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) { }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { }
}
`;
        const items = detectMobileItems(src, 'App/AppDelegate.swift', 'swift');
        expect(items.some(i => i.method === 'PUSH_HANDLER')).toBe(true);
    });

    it('Flutter firebase_messaging emits PUSH_HANDLER', () => {
        const src = `
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';

void main() async {
    FirebaseMessaging.onMessage.listen((message) { /* ... */ });
    FirebaseMessaging.onBackgroundMessage((message) async { /* ... */ });
}
`;
        const items = detectMobileItems(src, 'lib/main.dart', 'dart');
        expect(items.some(i => i.method === 'PUSH_HANDLER')).toBe(true);
    });

    it('React Native @react-native-firebase/messaging emits PUSH_HANDLER', () => {
        const src = `
import { View } from 'react-native';
import messaging from '@react-native-firebase/messaging';

messaging().onMessage(async remoteMessage => { /* ... */ });
messaging().setBackgroundMessageHandler(async remoteMessage => { /* ... */ });
`;
        const items = detectMobileItems(src, 'src/notifications.ts', 'typescript');
        const handlers = items.filter(i => i.method === 'PUSH_HANDLER');
        expect(handlers.length).toBeGreaterThanOrEqual(2);
    });
});

describe('Tier 2 — Mobile background tasks (BG_TASK)', () => {
    it('Android WorkManager Worker subclass emits BG_TASK', () => {
        const src = `
package com.example.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork() = Result.success()
}
`;
        const items = detectMobileItems(src, 'app/src/main/kotlin/SyncWorker.kt', 'kotlin');
        expect(items.some(i => i.method === 'BG_TASK' && i.handlerName === 'SyncWorker')).toBe(true);
    });

    it('iOS BGTaskScheduler.register emits BG_TASK', () => {
        const src = `
import BackgroundTasks
import UIKit

class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey : Any]?) -> Bool {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: "com.example.refresh", using: nil) { task in
            handleAppRefresh(task: task as! BGAppRefreshTask)
        }
        return true
    }
}
`;
        const items = detectMobileItems(src, 'App/AppDelegate.swift', 'swift');
        expect(items.some(i => i.method === 'BG_TASK' && i.route === 'bgtask:com.example.refresh')).toBe(true);
    });

    it('Flutter workmanager registerOneOffTask emits BG_TASK', () => {
        const src = `
import 'package:workmanager/workmanager.dart';
import 'package:flutter/material.dart';

void main() {
    Workmanager().initialize(callbackDispatcher);
    Workmanager().registerOneOffTask("uniqueName", "simpleTask");
}
`;
        const items = detectMobileItems(src, 'lib/main.dart', 'dart');
        expect(items.some(i => i.method === 'BG_TASK' && i.route === 'worker:uniqueName')).toBe(true);
    });

    it('React Native expo-task-manager defineTask emits BG_TASK', () => {
        const src = `
import { View } from 'react-native';
import * as TaskManager from 'expo-task-manager';

TaskManager.defineTask("BACKGROUND_FETCH_TASK", async () => { /* ... */ });
`;
        const items = detectMobileItems(src, 'src/background.ts', 'typescript');
        expect(items.some(i => i.method === 'BG_TASK')).toBe(true);
    });
});
