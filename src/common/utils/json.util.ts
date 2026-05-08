'use strict'

import { Prisma } from "@prisma-generated/client";

export const toJson = (v: unknown) => v as Prisma.InputJsonValue;