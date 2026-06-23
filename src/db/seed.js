import { hashPassword } from "../lib/password.js";
import { db, pool } from "../config/db.js";
import { users } from "./schema.js";

// One login-able user per role for development/testing.
const SEED_USERS = [
  { name: "Admin User", email: "admin@invensis.test", role: "admin" },
  { name: "Trainer User", email: "trainer@invensis.test", role: "trainer" },
  { name: "Sponsor User", email: "sponsor@invensis.test", role: "sponsor" },
  { name: "Learner User", email: "learner@invensis.test", role: "learner" },
];

const PASSWORD = "Password123!";

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);

  for (const u of SEED_USERS) {
    await db
      .insert(users)
      .values({ ...u, passwordHash })
      .onConflictDoUpdate({
        target: users.email,
        set: { passwordHash, role: u.role, name: u.name, isActive: true },
      });
    console.log(`seeded ${u.role.padEnd(8)} ${u.email}`);
  }

  console.log(`\nAll seed users share password: ${PASSWORD}`);
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
