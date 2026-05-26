import { optimizeSettlement } from './settlement';

const payments = optimizeSettlement([
  { userId: 'a', name: 'A', netCents: -30000 },
  { userId: 'b', name: 'B', netCents: 20000 },
  { userId: 'c', name: 'C', netCents: -5000 },
  { userId: 'd', name: 'D', netCents: 15000 }
]);
console.log(payments);
