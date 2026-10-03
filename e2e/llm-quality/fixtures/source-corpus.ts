/**
 * Source corpus the bench measures against — a realistic chunk of an
 * Express + Prisma + bcrypt handler file (lightly adapted from
 * node-express-realworld-example-app). The fixtures in
 * `findings-<model-class>.ts` quote (verbatim or paraphrased) from this
 * exact string. Keep them in sync.
 */
export const BENCH_SOURCE = `import * as bcrypt from 'bcryptjs';
import prisma from '../../../prisma/prisma-client';
import HttpException from '../../models/http-exception.model';
import generateToken from './token.utils';

export const createUser = async (input: any) => {
  const email = input.email?.trim();
  const username = input.username?.trim();
  const password = input.password?.trim();

  if (!email) {
    throw new HttpException(422, { errors: { email: ["can't be blank"] } });
  }

  if (!password) {
    throw new HttpException(422, { errors: { password: ["can't be blank"] } });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      username,
      email,
      password: hashedPassword,
    },
    select: {
      id: true,
      email: true,
      username: true,
    },
  });

  return {
    ...user,
    token: generateToken(user.id),
  };
};

export const login = async (userPayload: any) => {
  const email = userPayload.email?.trim();
  const password = userPayload.password?.trim();

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      password: true,
    },
  });

  if (user) {
    const match = await bcrypt.compare(password, user.password);
    if (match) {
      return {
        email: user.email,
        token: generateToken(user.id),
      };
    }
  }

  throw new HttpException(403, {
    errors: { 'email or password': ['is invalid'] },
  });
};

export const getCurrentUser = async (id: number) => {
  if (!id) {
    throw new HttpException(401, { errors: { authorization: ['is required'] } });
  }

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      username: true,
    },
  });

  if (!user) {
    throw new HttpException(404, { errors: { user: ['not found'] } });
  }

  return {
    ...user,
    token: generateToken(user.id),
  };
};
`;
