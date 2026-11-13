import { before, after } from 'node:test';
import { startDb } from './harness.mjs';
import { buildWorld, seedData } from './world.mjs';
import { structureTests } from './structure.part.mjs';
import { accessTests } from './access.part.mjs';
import { queueTests } from './queue.part.mjs';
import { clinicalTests } from './clinical.part.mjs';
import { concurrencyTests } from './concurrency.part.mjs';
import { staffTests } from './staff.part.mjs';
import { scheduleTests } from './schedule.part.mjs';
import { directoryTests } from './directory.part.mjs';
import { buildQueueWorld } from './qworld.mjs';

const ctx = {};
before(async () => {
  ctx.db = await startDb({ port: 54341 });
  ctx.w = await buildWorld(ctx.db);
  ctx.seed = await seedData(ctx.db, ctx.w);
  ctx.q = await buildQueueWorld(ctx.db);
});
after(async () => { await ctx.db?.stop(); });

structureTests(ctx);
accessTests(ctx);
queueTests(ctx);
clinicalTests(ctx);
concurrencyTests(ctx);
staffTests(ctx);
scheduleTests(ctx);
directoryTests(ctx);
