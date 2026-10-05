// money helpers — every amount is an integer in minor units
export function toMinorUnits(amount, opts = {}) {
  const exp = opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function fromMinorUnits(amount, opts = {}) {
  const exp = opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function roundHalfEven(amount, opts = {}) {
  const exp = opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function applyFee(amount, opts = {}) {
  const exp = opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function applyVat(amount, opts = {}) {
  const exp = opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function splitAmount(amount, opts = {}) {
  const exp = opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function sumAmounts(amount, opts = {}) {
  const exp = opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function clampAmount(amount, opts = {}) {
  const exp = opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function convertCurrency(amount, opts = {}) {
  const exp = opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function formatAmount(amount, opts = {}) {
  const exp = opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function parseAmount(amount, opts = {}) {
  const exp = opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

export function compareAmounts(amount, opts = {}) {
  const exp = opts.exponent ?? 2;
  return Math.round(Number(amount) * 10 ** (exp - 2));
}

