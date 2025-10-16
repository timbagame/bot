# 📋 Sistema de Referidos - Documentación Completa

## 🎯 **Resumen del Sistema**

El sistema de referidos permite a los usuarios ganar comisiones del 30% de los fees que genera el bot cuando sus referidos juegan coinflips. Se autofinancia completamente con los fees existentes del bot.

## 🔄 **Flujo Principal**

### **1. Registro de Usuario**
```
Usuario nuevo → /start → Se crea código automáticamente (r-username)
Usuario referido → /start r-alice → Se registra como referido de Alice
```

### **2. Tracking de Comisiones**
```
Referido juega coinflip → Juego se completa → Se calcula comisión → Se registra en DB
```

### **3. Payouts**
```
Script semanal → Suma comisiones pendientes → Paga si supera mínimo → Marca como pagadas
```

## 📊 **Casos Edge y Comportamientos**

### **✅ CASOS IMPLEMENTADOS CORRECTAMENTE**

| Caso | Comportamiento | Implementación |
|------|----------------|----------------|
| **Usuario sin referidor** | Crea código automáticamente | `processStartCommand()` sin parámetro |
| **Usuario existente usa código** | Falla - ya fue referido | `UNIQUE constraint` en DB |
| **Código inválido** | Falla - código no existe | Verificación en `getReferralCodeInfo()` |
| **Usuario sin username** | Usa telegramId como código | Fallback a `r-telegramId` |
| **Cambio de username** | Crea nuevo código | `createOrGetReferralCode()` |
| **Juegos cancelados** | No generan comisiones | Solo `processGameCompletion()` |
| **Comisiones pequeñas** | Se ignoran si ≤ 0 | Validación en `recordGameCommission()` |

### **✅ CASOS IMPLEMENTADOS Y CORREGIDOS**

| Caso | Estado | Implementación |
|------|--------|----------------|
| **Auto-referido** | ✅ CORREGIDO | Validación en `processStartCommand()` |
| **Cambio de username** | ✅ CORREGIDO | Método `updateReferralCode()` |
| **Inputs malformados** | ✅ CORREGIDO | Validación de telegram ID |
| **Limpieza de cuentas** | ⏳ PENDIENTE | Script periódico de limpieza |

## 🧮 **Cálculo de Comisiones**

### **Fórmula**
```
Bot Fee = Game Amount × 1%
Referral Commission = Bot Fee × 30%
```

### **Ejemplos**
| Monto del Juego | Fee del Bot | Comisión del Referidor |
|------------------|-------------|------------------------|
| 100 TIMBA | 1 TIMBA | 0.3 TIMBA |
| 1,000 TIMBA | 10 TIMBA | 3 TIMBA |
| 10,000 TIMBA | 100 TIMBA | 30 TIMBA |
| 100,000 TIMBA | 1,000 TIMBA | 300 TIMBA |

## 🗄️ **Estructura de Base de Datos**

### **Tabla: referral_codes**
```sql
CREATE TABLE referral_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL UNIQUE,        -- ID del usuario
  username TEXT,                           -- Username (puede ser NULL)
  referral_code TEXT NOT NULL UNIQUE,      -- Código único (r-username)
  created_at INTEGER NOT NULL,             -- Timestamp de creación
  total_referrals INTEGER DEFAULT 0,      -- Contador de referidos
  total_earned INTEGER DEFAULT 0,          -- Total ganado (raw tokens)
  is_active BOOLEAN DEFAULT 1             -- Estado activo
);
```

### **Tabla: referrals**
```sql
CREATE TABLE referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_code TEXT NOT NULL,             -- Código del referidor
  referred_telegram_id TEXT NOT NULL UNIQUE, -- ID del referido
  created_at INTEGER NOT NULL,             -- Timestamp de registro
  is_active BOOLEAN DEFAULT 1,             -- Estado activo
  FOREIGN KEY (referrer_code) REFERENCES referral_codes(referral_code)
);
```

### **Tabla: referral_commissions**
```sql
CREATE TABLE referral_commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_telegram_id TEXT NOT NULL,      -- ID del referidor
  game_address TEXT NOT NULL,              -- Dirección del juego
  commission_amount INTEGER NOT NULL,      -- Monto de comisión (raw)
  token_mint TEXT NOT NULL,                -- Mint del token
  token_ticker TEXT NOT NULL,              -- Ticker del token
  game_amount INTEGER NOT NULL,            -- Monto original del juego
  created_at INTEGER NOT NULL,             -- Timestamp del juego
  paid_out BOOLEAN DEFAULT 0,              -- Si ya se pagó
  paid_at INTEGER                           -- Cuándo se pagó
);
```

## 🎮 **Comandos y UI**

### **Comandos Disponibles**
- `/start` - Registro normal
- `/start r-username` - Registro con código de referido
- Botón "🎁 Rewards" - Dashboard de referidos

### **Botones del Dashboard**
- **🔄 Refresh** - Actualizar estadísticas
- **← Back to Wallet** - Volver al wallet principal

### **Ejemplo de UI**
```
REWARDS & REFERRALS

Total Earned: 1.250000 TIMBA
Pending Payout: 0.500000 TIMBA

Your Stats:
• Referrals: 6 users
• Games generated: 23 coinflips  
• Commission rate: 30%

Your Referral Link:
https://t.me/coinflip_sol_bot?start=r-alice

Share this link to earn 30% commission on your friends' games!

[🔄 Refresh] [← Back to Wallet]
```

## ⚙️ **Configuración**

### **Parámetros Configurables**
```typescript
const REFERRAL_CONFIG = {
  COMMISSION_RATE: 0.30,           // 30% del fee del bot
  PAYOUT_INTERVAL_HOURS: 168,      // Semanal (7 días)
  MIN_PAYOUT_MULTIPLIER: 1.0,      // 1x el mínimo del token
  NEW_USER_BONUS_RATE: 0.10,       // 10% bonus para nuevos usuarios
  CODE_PREFIX: "r-",               // Prefijo para códigos
  MAX_CODE_LENGTH: 20,             // Máximo largo del código
};
```

## 🚀 **Scripts de Mantenimiento**

### **Script de Payout Semanal**
```typescript
// scripts/pay-referral-commissions.ts
const payReferralCommissions = async () => {
  // 1. Obtener todas las comisiones no pagadas
  // 2. Agrupar por usuario
  // 3. Verificar si superan el mínimo
  // 4. Pagar en batch
  // 5. Marcar como pagadas
};
```

### **Script de Limpieza**
```typescript
// scripts/cleanup-referral-data.ts
const cleanupInactiveAccounts = async () => {
  // Marcar como inactivas cuentas sin actividad por X días
  // Opcional: eliminar datos de cuentas muy antiguas
};
```

## 🧪 **Testing**

### **Pruebas Básicas**
```bash
bun run scripts/test-referral-system.ts
```

### **Pruebas Unitarias**
```bash
bun test tests/referral-system.test.ts
```

### **Casos de Prueba Cubiertos (19 tests - 100% passing)**
- ✅ Flujo básico de referidos (3 tests)
- ✅ Casos edge (4 tests) - auto-referido, códigos inválidos, cambios username, inputs malformados
- ✅ Cálculo de comisiones (3 tests)
- ✅ Estadísticas y UI (3 tests)
- ✅ Escenarios complejos (3 tests) - cadenas de referidos, múltiples juegos, integridad
- ✅ Manejo de errores (2 tests)
- ✅ Rendimiento (1 test) - 100 referidos en <2 segundos

## 🔒 **Consideraciones de Seguridad**

### **Prevención de Gaming**
- Un usuario solo puede ser referido una vez
- Relación de referido es permanente
- Comisiones solo por juegos completados
- Validación de códigos de referido

### **Protección de Datos**
- No se almacenan datos sensibles
- Solo IDs de Telegram y usernames
- Datos persisten para auditoría
- No hay limpieza automática de datos

## 📈 **Métricas y Monitoreo**

### **Métricas Clave**
- Total de referidos por usuario
- Comisiones generadas por día/semana
- Tasa de conversión de referidos
- Retención de usuarios referidos

### **Logs Importantes**
- Registro de referidos exitosos
- Errores en códigos de referido
- Comisiones registradas
- Errores en payouts

## 🚨 **Problemas Conocidos y Soluciones**

### **Problema: Auto-referidos**
**Solución:** Agregar validación en `registerReferral()`
```typescript
if (referrerInfo.telegram_id === referredTelegramId) {
  return false; // No puede referirse a sí mismo
}
```

### **Problema: Códigos duplicados por cambio de username**
**Solución:** Actualizar código existente en lugar de crear nuevo
```typescript
public updateReferralCode(telegramId: string, newUsername: string): string {
  const newCode = `r-${newUsername}`;
  this.db.prepare(`
    UPDATE referral_codes 
    SET username = ?, referral_code = ? 
    WHERE telegram_id = ?
  `).run(newUsername, newCode, telegramId);
  return newCode;
}
```

### **Problema: Limpieza de cuentas eliminadas**
**Solución:** Script periódico de limpieza
```typescript
public cleanupInactiveAccounts(): void {
  // Marcar como inactivas cuentas sin actividad por X días
  // Opcional: eliminar datos de cuentas muy antiguas
}
```

## 🎯 **Próximos Pasos**

1. **Implementar mejoras identificadas**
2. **Crear script de payout semanal**
3. **Agregar métricas y dashboard admin**
4. **Implementar notificaciones de comisiones**
5. **Optimizar rendimiento para muchos usuarios**
6. **Agregar sistema de niveles/bonificaciones**
