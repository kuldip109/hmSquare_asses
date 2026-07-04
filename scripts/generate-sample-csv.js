/**
 * Generates a sample orders CSV for local testing.
 * Usage: node scripts/generate-sample-csv.js [rowCount] [outputPath]
 */
const fs = require('fs');
const { randomUUID } = require('crypto');

const rowCount = parseInt(process.argv[2] || '10000', 10);
const outputPath = process.argv[3] || 'sample-orders.csv';

const statuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];

const lines = ['order_id,customer_id,order_date,order_amount,status'];

for (let i = 0; i < rowCount; i++) {
  // Sprinkle in ~1% intentionally invalid rows to exercise error handling.
  const makeInvalid = i % 97 === 0;

  const orderId = randomUUID();
  const customerId = `cust-${(i % 1500) + 1}`;
  const date = new Date(Date.now() - Math.floor(Math.random() * 1e10)).toISOString();
  const amount = (Math.random() * 500).toFixed(2);
  const status = statuses[i % statuses.length];

  if (makeInvalid) {
    lines.push(`${orderId},${customerId},NOT-A-DATE,${amount},${status}`);
  } else {
    lines.push(`${orderId},${customerId},${date},${amount},${status}`);
  }
}

fs.writeFileSync(outputPath, lines.join('\n'));
console.log(`Wrote ${rowCount} rows to ${outputPath}`);
