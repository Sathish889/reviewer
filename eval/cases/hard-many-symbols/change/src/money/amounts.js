// money helpers — every amount is an integer in minor units.
// ctx carries the currency's exponent: JPY has 0 decimals, KWD has 3.
export function toMinorUnits(ctx, amount, opts = {}) {
  const exp = ctx.exponent ?? opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function fromMinorUnits(ctx, amount, opts = {}) {
  const exp = ctx.exponent ?? opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function roundHalfEven(ctx, amount, opts = {}) {
  const exp = ctx.exponent ?? opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function applyFee(ctx, amount, opts = {}) {
  const exp = ctx.exponent ?? opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function applyVat(ctx, amount, opts = {}) {
  const exp = ctx.exponent ?? opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function splitAmount(ctx, amount, opts = {}) {
  const exp = ctx.exponent ?? opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function sumAmounts(ctx, amount, opts = {}) {
  const exp = ctx.exponent ?? opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function clampAmount(ctx, amount, opts = {}) {
  const exp = ctx.exponent ?? opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function convertCurrency(ctx, amount, opts = {}) {
  const exp = ctx.exponent ?? opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function formatAmount(ctx, amount, opts = {}) {
  const exp = ctx.exponent ?? opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function parseAmount(ctx, amount, opts = {}) {
  const exp = ctx.exponent ?? opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function compareAmounts(ctx, amount, opts = {}) {
  const exp = ctx.exponent ?? opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

