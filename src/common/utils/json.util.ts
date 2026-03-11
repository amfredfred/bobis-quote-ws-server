'use strict'

import { Prisma } from "src/prisma/generated/client";

export const toJson = (v: unknown) => v as Prisma.InputJsonValue;