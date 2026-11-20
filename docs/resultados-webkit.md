# Resultados (webkit 2026-11-20 16:49)

**11/11 pruebas superadas**

| | Prueba | Detalle |
|---|---|---|
| ✅ | Abre directamente en Registrar con Texto/Voz/Foto visibles sin desplazarse | modos: ⌨︎ Texto / 🎙 Voz / 📷 Foto; con el resumen semanal visible, el botón Registrar termina en 752 px y la barra empieza en 774 px |
| ✅ | Gasto simple en 3 pasos: monto → concepto → Registrar, con estado "en el iPhone" y luego "confirmado por Sheets" | botón: "✓ En el iPhone · enviando…" → "✓ Confirmado en Sheets"; en Sheets: $200 · café en Starbucks · Comida |
| ✅ | Offline: 2 gastos sin internet → cerrar → reabrir sin internet → volver internet → llegan a Sheets exactamente una vez | reapertura con Sheets inaccesible; Sheets: Uber×1, Tacos×1; 2 filas nuevas tras 2 reaperturas |
| ✅ | Respuesta perdida: Sheets escribe pero la conexión se corta → reintento → sigue habiendo una sola fila | respuesta perdida tras escribir; la app mostró "1 sin enviar · reintentar" sin declarar éxito; 2 reintento(s) con el indicador; el servidor recibió 3 envíos y hay 1 sola fila |
| ✅ | Meta: la imagen se revela según el ahorro y conserva el progreso al reabrir (abonos sin duplicados) | 20% → 50% → 60%; Sheets: $6000 ahorrado, 2 abonos; clip-path inset(40% 0px 0px) |
| ✅ | Foto ambigua: no rellena el monto, pide revisión y no guarda hasta que lo confirmes | avisos mostrados: • No se leyó el total con certeza: escríbelo tú.• Aparecen dos montos (152.00 y 125.00) y no está claro cuál es el total• La fecha no aparece: se usará la de hoy. Cámbiala si no es correcta.; guardado tras corregir: $152 · OXXO · "foto: corregido" |
| ✅ | Foto clara: rellena monto, comercio y fecha; todo editable antes de guardar | concepto corregido a mano; modelo solicitado: claude-opus-5-5 |
| ✅ | Voz (reconocimiento simulado): interpreta "doscientos cincuenta en tacos" y deja corregir antes de guardar | interpretado $250 · Tacos → corregido a $260 → en Sheets |
| ✅ | Atajo: vista previa no escribe; confirmar escribe una vez; repetir no duplica; sin monto no guarda | mensaje: "✓ En Sheets: $200 · Café (Comida). Te quedan $23,447 este mes." |
| ✅ | Banner semanal con presupuesto restante | Semana: $1,554 · puedes gastar ~$2,132/día por 11 días |
| ✅ | Sin errores de JavaScript durante todo el recorrido |  |
