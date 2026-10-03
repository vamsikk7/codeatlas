
import express from 'express';
import { getUsers } from './controllers/userController.js';
const app = express();
app.get('/users', getUsers);
