import bcrypt from "bcryptjs";

const COST = 12; // per architecture doc §2.2

export const hashPassword = (plain) => bcrypt.hash(plain, COST);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);
