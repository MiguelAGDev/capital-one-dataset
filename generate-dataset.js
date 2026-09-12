/**
 * generate_dataset.js
 *
 * Siembra (POST) ~120 días de transacciones sintéticas-pero-realistas en Nessie
 * para un negocio tipo "minisúper", y luego las extrae (GET) en dos datasets
 * CSV listos para entrenar un modelo probabilístico (SARIMAX / similar).
 *
 * Por qué "sintéticas": Nessie es un sandbox donde cada API key empieza vacía
 * (confirmado en vivo el 12-sep-2026 — ver sección 11 del doc del proyecto).
 * No existe un historial real de 3 meses ya esperando; hay que crearlo. Los
 * montos y frecuencias vienen del perfil real documentado del nicho (sección 4
 * del doc), no de números al azar sin sentido, y se les agrega variación
 * natural porque un modelo probabilístico necesita algo de ruido para tener
 * incertidumbre que modelar.
 *
 * Decisión de diseño: en vez de crear 60-150 depósitos individuales por día
 * (decenas de miles de llamadas a la API — inviable en el tiempo de un
 * hackathon y contra el rate limit del sandbox compartido), se crea UN
 * depósito diario que representa el total de ventas del día ("Ventas del
 * día"). Para forecasting de flujo de caja diario esto es equivalente y es
 * la práctica estándar — lo que importa es el neto diario, no cada ticket
 * individual.
 *
 * Uso:
 *   1. npm install axios dotenv
 *   2. Copia .env.example a .env y pon tu NESSIE_API_KEY
 *   3. node generate_dataset.js
 *
 * Historial por defecto: 365 días (~12 meses), siguiendo la recomendación de
 * 6-12 meses mínimo para SARIMAX/TBATS (2-3 ciclos completos de estacionalidad).
 * Esto implica ~365-500 llamadas POST a la API — con el rate limiting del
 * script (120ms entre llamadas) tarda aprox. 1-2 minutos en correr.
 *
 * Salida:
 *   dataset_transactions.csv  — una fila por transacción (deposit/purchase/bill)
 *   dataset_daily.csv         — una fila por día calendario, listo para SARIMAX
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const API_KEY = process.env.NESSIE_API_KEY;
const BASE_URL = process.env.NESSIE_BASE_URL || 'http://api.nessieisreal.com';
const DAYS_HISTORY = parseInt(process.env.DAYS_HISTORY || '120', 10);

if (!API_KEY) {
  console.error('Falta NESSIE_API_KEY en tu .env');
  process.exit(1);
}

const client = axios.create({ baseURL: BASE_URL, timeout: 15000 });

// ---------- utilidades ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, label, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 429 || (status >= 500 && status < 600);
      if (!isRetryable || attempt === retries) {
        console.error(`Fallo en "${label}" (intento ${attempt}):`, status, err.response?.data || err.message);
        throw err;
      }
      const backoff = 500 * attempt;
      console.warn(`Reintentando "${label}" en ${backoff}ms (status ${status})...`);
      await sleep(backoff);
    }
  }
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Multiplicador de estacionalidad semanal para depósitos (minisúper):
// pico viernes/sábado, mínimo domingo/lunes.
const WEEKDAY_MULTIPLIER = {
  0: 0.75, // domingo
  1: 0.8,  // lunes
  2: 0.9,  // martes
  3: 0.95, // miércoles
  4: 1.05, // jueves
  5: 1.25, // viernes
  6: 1.3,  // sábado
};

// Festivos con impacto real en ventas de un minisúper (clave MM-DD, fechas fijas
// para simplificar — no se calculan los "lunes de" oficiales). El multiplicador
// se aplica sobre la venta base del día: >1 = pico de ventas, <1 = negocio
// cerrado/reducido. Sin esto, la columna "Festivo" no tendría señal real que
// un modelo pudiera aprender (petición explícita del doc de Azucena).
const HOLIDAYS = {
  '01-01': 0.3, // Año Nuevo — cerrado/muy bajo
  '02-05': 1.0, // Día de la Constitución
  '03-21': 1.0, // Natalicio Benito Juárez
  '05-01': 0.5, // Día del Trabajo — cierres parciales
  '05-10': 1.6, // Día de las Madres — pico fuerte
  '09-16': 0.6, // Día de la Independencia — cierres parciales
  '11-02': 1.3, // Día de Muertos
  '11-20': 1.0, // Día de la Revolución
  '12-25': 0.2, // Navidad — cerrado/muy bajo
};

function mmdd(date) {
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ---------- paso 1: customer ----------

async function getOrCreateCustomer() {
  const { data: customers } = await withRetry(
    () => client.get('/customers', { params: { key: API_KEY } }),
    'GET /customers'
  );

  const existing = customers.find(
    (c) => c.first_name === 'Minisuper' && c.last_name === 'Demo HackMTY'
  );
  if (existing) {
    console.log(`Customer ya existe: ${existing._id}`);
    return existing._id;
  }

  const { data: created } = await withRetry(
    () =>
      client.post('/customers', {
        first_name: 'Minisuper',
        last_name: 'Demo HackMTY',
        address: {
          street_number: '123',
          street_name: 'Av. Constitución',
          city: 'Monterrey',
          state: 'NL',
          zip: '64000',
        },
      }, { params: { key: API_KEY } }),
    'POST /customers'
  );
  const id = created.objectCreated ? created.objectCreated._id : created._id;
  console.log(`Customer creado: ${id}`);
  return id;
}

// ---------- paso 2: accounts ----------

async function getOrCreateAccount(customerId, type, nickname, initialBalance) {
  const { data: accounts } = await withRetry(
    () => client.get(`/customers/${customerId}/accounts`, { params: { key: API_KEY } }),
    'GET accounts'
  );
  const existing = accounts.find((a) => a.type === type && a.nickname === nickname);
  if (existing) {
    console.log(`Account "${nickname}" ya existe: ${existing._id}`);
    return existing;
  }

  const { data: created } = await withRetry(
    () =>
      client.post(`/customers/${customerId}/accounts`, {
        type,
        nickname,
        rewards: 0,
        balance: initialBalance,
      }, { params: { key: API_KEY } }),
    'POST accounts'
  );
  const account = created.objectCreated || created;
  console.log(`Account "${nickname}" creada: ${account._id}`);
  return account;
}

// ---------- paso 3: merchant para compras a proveedor ----------

async function getOrCreateMerchant() {
  const { data: merchants } = await withRetry(
    () => client.get('/merchants', { params: { key: API_KEY } }),
    'GET /merchants'
  );
  const existing = merchants.find((m) => m.name === 'Proveedor Central Abarrotes');
  if (existing) return existing._id;

  const { data: created } = await withRetry(
    () =>
      client.post('/merchants', {
        name: 'Proveedor Central Abarrotes',
        category: 'wholesale',
        address: {
          street_number: '500',
          street_name: 'Av. Industrial',
          city: 'Monterrey',
          state: 'NL',
          zip: '64000',
        },
        geocode: { lat: 25.6866, lng: -100.3161 },
      }, { params: { key: API_KEY } }),
    'POST /merchants'
  );
  const merchant = created.objectCreated || created;
  return merchant._id;
}

// ---------- paso 4: generar y sembrar transacciones ----------

async function seedTransactions(checkingId, merchantId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - DAYS_HISTORY);

  let lastPurchaseDate = new Date(start);

  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const date = new Date(d);
    const dow = date.getDay();
    const dateStr = fmtDate(date);

    // --- Deposit: ventas agregadas del día ---
    // Perfil minisúper: 60-150 depósitos/día, ticket $40-120 MXN => venta diaria total ~$3,500-11,000
    const holidayMultiplier = HOLIDAYS[mmdd(date)] ?? 1.0;
    const baseDailySales = randRange(3500, 11000) * WEEKDAY_MULTIPLIER[dow] * holidayMultiplier;
    const depositAmount = round2(baseDailySales);

    await withRetry(
      () =>
        client.post(`/accounts/${checkingId}/deposits`, {
          medium: 'balance',
          status: 'completed',
          transaction_date: dateStr,
          amount: depositAmount,
          description: 'Ventas del día',
        }, { params: { key: API_KEY } }),
      `deposit ${dateStr}`
    );
    await sleep(120);

    // --- Purchase: reposición de inventario cada 2-3 días ---
    const daysSincePurchase = (date - lastPurchaseDate) / (1000 * 60 * 60 * 24);
    if (daysSincePurchase >= 2 && Math.random() < 0.6) {
      const purchaseAmount = round2(randRange(3000, 8000));
      await withRetry(
        () =>
          client.post(`/accounts/${checkingId}/purchases`, {
            merchant_id: merchantId,
            medium: 'balance',
            status: 'completed',
            purchase_date: dateStr,
            amount: purchaseAmount,
            description: 'Reposición de inventario',
          }, { params: { key: API_KEY } }),
        `purchase ${dateStr}`
      );
      lastPurchaseDate = new Date(date);
      await sleep(120);
    }

    // --- Bills: renta (día 1), nómina (día 15 y último día de mes), luz (día 20) ---
    const dayOfMonth = date.getDate();
    const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();

    if (dayOfMonth === 1) {
      await withRetry(
        () =>
          client.post(`/accounts/${checkingId}/bills`, {
            status: 'completed',
            payee: 'Arrendadora Local',
            nickname: 'Renta',
            payment_date: dateStr,
            recurring_date: 1,
            payment_amount: round2(randRange(5800, 6200)),
          }, { params: { key: API_KEY } }),
        `bill renta ${dateStr}`
      );
      await sleep(120);
    }

    if (dayOfMonth === 15 || dayOfMonth === lastDayOfMonth) {
      await withRetry(
        () =>
          client.post(`/accounts/${checkingId}/bills`, {
            status: 'completed',
            payee: 'Nómina',
            nickname: 'Nómina quincenal',
            payment_date: dateStr,
            recurring_date: dayOfMonth === 15 ? 15 : lastDayOfMonth,
            payment_amount: round2(randRange(4000, 7000)),
          }, { params: { key: API_KEY } }),
        `bill nomina ${dateStr}`
      );
      await sleep(120);
    }

    if (dayOfMonth === 20) {
      await withRetry(
        () =>
          client.post(`/accounts/${checkingId}/bills`, {
            status: 'completed',
            payee: 'CFE',
            nickname: 'Luz',
            payment_date: dateStr,
            recurring_date: 20,
            payment_amount: round2(randRange(800, 1500)),
          }, { params: { key: API_KEY } }),
        `bill luz ${dateStr}`
      );
      await sleep(120);
    }

    if (dayOfMonth % 10 === 0) {
      console.log(`Sembrado hasta ${dateStr}...`);
    }
  }
}

// ---------- paso 5: extraer todo de vuelta ----------

async function fetchAll(checkingId) {
  const [deposits, purchases, bills] = await Promise.all([
    withRetry(() => client.get(`/accounts/${checkingId}/deposits`, { params: { key: API_KEY } }), 'GET deposits'),
    withRetry(() => client.get(`/accounts/${checkingId}/purchases`, { params: { key: API_KEY } }), 'GET purchases'),
    withRetry(() => client.get(`/accounts/${checkingId}/bills`, { params: { key: API_KEY } }), 'GET bills'),
  ]);
  return { deposits: deposits.data, purchases: purchases.data, bills: bills.data };
}

// ---------- paso 6: exportar CSVs ----------

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeTransactionsCsv(path, deposits, purchases, bills, accountId) {
  const rows = [['date', 'type', 'amount', 'description', 'account_id']];
  for (const d of deposits) {
    rows.push([d.transaction_date, 'deposit', d.amount, d.description || '', accountId]);
  }
  for (const p of purchases) {
    rows.push([p.purchase_date, 'purchase', p.amount, p.description || '', accountId]);
  }
  for (const b of bills) {
    rows.push([b.payment_date, 'bill', b.payment_amount, b.nickname || '', accountId]);
  }
  rows.sort((a, b) => (a[0] > b[0] ? 1 : -1));
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  fs.writeFileSync(path, csv);
  console.log(`Escrito ${path} (${rows.length - 1} filas)`);
}

function writeDailyCsv(path, deposits, purchases, bills, startingBalance) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - DAYS_HISTORY);

  const byDay = {};
  const ensureDay = (dateStr) => {
    if (!byDay[dateStr]) {
      byDay[dateStr] = {
        total_deposits: 0,
        n_deposits: 0,
        total_purchases: 0,
        n_purchases: 0,
        bills_amount: 0,
        bills_due: 0,
      };
    }
    return byDay[dateStr];
  };

  for (const d of deposits) {
    const day = ensureDay(d.transaction_date);
    day.total_deposits += d.amount;
    day.n_deposits += 1;
  }
  for (const p of purchases) {
    const day = ensureDay(p.purchase_date);
    day.total_purchases += p.amount;
    day.n_purchases += 1;
  }
  for (const b of bills) {
    const day = ensureDay(b.payment_date);
    day.bills_amount += b.payment_amount;
    day.bills_due = 1;
  }

  const rows = [[
    'date', 'day_of_week', 'month', 'is_weekend', 'is_holiday',
    'total_deposits', 'n_deposits', 'total_purchases', 'n_purchases',
    'bills_amount', 'bills_due', 'net_flow', 'running_balance',
  ]];

  let runningBalance = startingBalance;
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const dateStr = fmtDate(d);
    const dow = d.getDay();
    const month = d.getMonth() + 1;
    const isHoliday = HOLIDAYS[mmdd(d)] !== undefined ? 1 : 0;
    const day = byDay[dateStr] || {
      total_deposits: 0, n_deposits: 0, total_purchases: 0, n_purchases: 0,
      bills_amount: 0, bills_due: 0,
    };
    const netFlow = round2(day.total_deposits - day.total_purchases - day.bills_amount);
    runningBalance = round2(runningBalance + netFlow);

    rows.push([
      dateStr, dow, month, dow === 0 || dow === 6 ? 1 : 0, isHoliday,
      round2(day.total_deposits), day.n_deposits,
      round2(day.total_purchases), day.n_purchases,
      round2(day.bills_amount), day.bills_due,
      netFlow, runningBalance,
    ]);
  }

  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  fs.writeFileSync(path, csv);
  console.log(`Escrito ${path} (${rows.length - 1} días)`);
}

// ---------- main ----------

(async () => {
  console.log(`Sembrando ${DAYS_HISTORY} días de historial para minisúper demo...`);

  const customerId = await getOrCreateCustomer();
  const checking = await getOrCreateAccount(customerId, 'Checking', 'Cuenta Operativa', 15000);
  await getOrCreateAccount(customerId, 'Savings', 'Buffer de Liquidez', 0);
  const merchantId = await getOrCreateMerchant();

  await seedTransactions(checking._id, merchantId);

  console.log('Extrayendo transacciones sembradas...');
  const { deposits, purchases, bills } = await fetchAll(checking._id);

  writeTransactionsCsv('dataset_transactions.csv', deposits, purchases, bills, checking._id);
  writeDailyCsv('dataset_daily.csv', deposits, purchases, bills, checking.balance);

  console.log('Listo. customer_id:', customerId, '| checking_account_id:', checking._id);
})().catch((err) => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});