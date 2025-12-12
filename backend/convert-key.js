import bs58 from "bs58";

const secretArray = [
  160, 133, 184, 114, 21, 79, 72, 89, 89, 4, 199, 204, 3, 138, 154, 226, 177,
  13, 26, 216, 117, 49, 218, 136, 97, 66, 104, 82, 85, 150, 213, 45, 121, 120,
  93, 33, 212, 225, 202, 151, 46, 236, 136, 178, 72, 124, 41, 94, 197, 230, 115,
  78, 40, 224, 228, 157, 223, 0, 196, 211, 41, 125, 75, 220,
];
const base58Key = bs58.encode(Buffer.from(secretArray));

console.log("\nYour base58 encoded WALLET_SECRET_KEY:");
console.log(base58Key);
console.log("\nUpdate your .env file with:");
console.log(`WALLET_SECRET_KEY=${base58Key}`);
