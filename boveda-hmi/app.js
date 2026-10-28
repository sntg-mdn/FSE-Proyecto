const video = document.getElementById('videoInput');
const canvas = document.getElementById('overlayCanvas');
const statusBox = document.getElementById('status-box');
const btnConectarBT = document.getElementById('btnConectarBT');
const btnIniciarVoz = document.getElementById('btnIniciarVoz');

// Configuración
const INTEGRANTES = ['david', 'santiago', 'abner']; 
const RUTA_MODELOS = './models';
const RUTA_FOTOS = './registros';
const UMBRAL_DISTANCIA = 0.50;

// Temporizaciones (en milisegundos)
const TIEMPO_ROSTRO_ESTATICO_MS = 2000; // 2 segundos continuos firme
const TIMEOUT_ERROR_FACIAL_MS = 30000;  // 30 s sin presencia para limpiar aviso
const TIMEOUT_VOZ_MS = 60000;          // 60 s para dictar clave
const TIEMPO_BLOQUEO_MS = 60000;       // 60 s de penalización por 3 fallos

// Variables de estado
let labeledFaceDescriptors = null;
let intervalDeteccion = null;
let bluetoothCharacteristic = null;

let estadoActual = 'ESPERA_ROSTRO'; 
let tiempoPrimerAvistamiento = null;
let temporizadorInactividad = null;
let temporizadorVoz = null;
let temporizadorBloqueo = null;
let recognitionInstance = null;

// Contador de seguridad
let contadorFallos = 0;
const MAX_FALLOS = 3;

async function inicializar() {
  try {
    actualizarInterfaz('Cargando modelos de IA...', '#333');
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(RUTA_MODELOS),
      faceapi.nets.faceLandmark68Net.loadFromUri(RUTA_MODELOS),
      faceapi.nets.faceRecognitionNet.loadFromUri(RUTA_MODELOS)
    ]);

    actualizarInterfaz('Cargando credenciales...', '#333');
    labeledFaceDescriptors = await cargarRostrosAutorizados();

    actualizarInterfaz('Iniciando sensor de video...', '#333');
    await iniciarCamara();
  } catch (err) {
    console.error(err);
    actualizarInterfaz(`Fallo: ${err.message}`, '#8b0000');
  }
}

async function cargarRostrosAutorizados() {
  return Promise.all(
    INTEGRANTES.map(async (nombre) => {
      const img = await faceapi.fetchImage(`${RUTA_FOTOS}/${nombre}.jpg`);
      const det = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
      if (!det) throw new Error(`Sin rostro claro en ${nombre}.jpg`);
      return new faceapi.LabeledFaceDescriptors(nombre, [det.descriptor]);
    })
  );
}

async function iniciarCamara() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
    audio: false
  });
  video.srcObject = stream;
}

video.addEventListener('play', () => {
  const displaySize = { width: video.clientWidth || 640, height: video.clientHeight || 480 };
  faceapi.matchDimensions(canvas, displaySize);
  const faceMatcher = new faceapi.FaceMatcher(labeledFaceDescriptors, UMBRAL_DISTANCIA);

  iniciarEscaneoFacial(faceMatcher, displaySize);
});

function iniciarEscaneoFacial(faceMatcher, displaySize) {
  estadoActual = 'ESPERA_ROSTRO';
  tiempoPrimerAvistamiento = null;
  actualizarInterfaz('SISTEMA ACTIVO: Mire a la cámara para autenticar', '#1a365d');

  if (intervalDeteccion) clearInterval(intervalDeteccion);

  intervalDeteccion = setInterval(async () => {
    if (estadoActual !== 'ESPERA_ROSTRO') return;

    const detections = await faceapi
      .detectAllFaces(video, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (estadoActual !== 'ESPERA_ROSTRO') return;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (detections.length === 0) {
      tiempoPrimerAvistamiento = null;
      return;
    }

    if (!tiempoPrimerAvistamiento) {
      tiempoPrimerAvistamiento = Date.now();
    }

    const resized = faceapi.resizeResults(detections, displaySize);
    const primary = resized[0];
    const match = faceMatcher.findBestMatch(primary.descriptor);
    const box = primary.detection.box;

    const tiempoSostenido = Date.now() - tiempoPrimerAvistamiento;

    if (tiempoSostenido < TIEMPO_ROSTRO_ESTATICO_MS) {
      dibujarRecuadro(ctx, box, '#ecc94b', 'Identificando... Quédese quieto');
      actualizarInterfaz('Rostro detectado. Manténgase firme...', '#744210');
      return;
    }

    if (match.label !== 'unknown') {
      estadoActual = 'APROBADO';
      clearInterval(intervalDeteccion);
      intervalDeteccion = null;
      contadorFallos = 0;
      limpiarTimeoutReinicio();

      dibujarRecuadro(ctx, box, '#38a169', `✔ AUTORIZADO: ${match.label.toUpperCase()}`);
      actualizarInterfaz(`✔ IDENTIDAD CONFIRMADA: ${match.label.toUpperCase()}`, '#22543d');
      enviarAlESP32('F');

      setTimeout(() => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        iniciarFaseVoz();
      }, 800);

    } else {
      tiempoPrimerAvistamiento = null;
      contadorFallos++;
      enviarAlESP32('X');

      dibujarRecuadro(ctx, box, '#e53e3e', `ACCESO DENEGADO (${contadorFallos}/${MAX_FALLOS})`);
      actualizarInterfaz(`ERROR: No autorizado. Intento ${contadorFallos} de ${MAX_FALLOS}`, '#742a2a');

      if (contadorFallos >= MAX_FALLOS) {
        activarBloqueoSeguridad(faceMatcher, displaySize);
      } else {
        iniciarTimeoutReinicio(TIMEOUT_ERROR_FACIAL_MS);
      }
    }
  }, 200);
}

function activarBloqueoSeguridad(faceMatcher, displaySize) {
  estadoActual = 'BLOQUEADO';
  clearInterval(intervalDeteccion);
  intervalDeteccion = null;
  limpiarTimeoutReinicio();

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setTimeout(() => ctx.clearRect(0, 0, canvas.width, canvas.height), 250);

  enviarAlESP32('B');
  let segundosRestantes = TIEMPO_BLOQUEO_MS / 1000;

  actualizarInterfaz(`¡SISTEMA BLOQUEADO POR SEGURIDAD! Espere: ${segundosRestantes}s`, '#4a0e0e');

  temporizadorBloqueo = setInterval(() => {
    segundosRestantes--;
    actualizarInterfaz(`¡SISTEMA BLOQUEADO POR SEGURIDAD! Espere: ${segundosRestantes}s`, '#4a0e0e');

    if (segundosRestantes <= 0) {
      clearInterval(temporizadorBloqueo);
      temporizadorBloqueo = null;
      contadorFallos = 0;
      tiempoPrimerAvistamiento = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      iniciarEscaneoFacial(faceMatcher, displaySize);
    }
  }, 1000);
}
function iniciarFaseVoz() {
  estadoActual = 'FASE_VOZ';
  actualizarInterfaz('FASE 2: AUTENTICACIÓN POR VOZ — Diga la clave (60s)', '#2b6cb0');

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    actualizarInterfaz('Navegador sin soporte de voz nativo', '#742a2a');
    return;
  }

  recognitionInstance = new SpeechRecognition();
  recognitionInstance.lang = 'es-MX';
  recognitionInstance.continuous = false;
  recognitionInstance.interimResults = false;

  temporizadorVoz = setTimeout(() => {
    abortarFaseVoz('Tiempo agotado en fase de voz. Reiniciando...');
  }, TIMEOUT_VOZ_MS);

  recognitionInstance.onresult = (event) => {
    clearTimeout(temporizadorVoz);
    const audioTexto = event.results[0][0].transcript.toLowerCase().trim();
    console.log('[Voz recibida]:', audioTexto);

    if (audioTexto.includes('abrir') && (audioTexto.includes('boveda') || audioTexto.includes('bóveda'))) {
      actualizarInterfaz(`✔ CLAVE CORRECTA ("${audioTexto}"). PASE AL SENSOR DE HUELLA`, '#22543d');
      enviarAlESP32('V'); // Fase 2 OK
    } else {
      actualizarInterfaz(`Clave incorrecta: "${audioTexto}". Intente de nuevo...`, '#742a2a');
      enviarAlESP32('X');
      setTimeout(() => {
        if (estadoActual === 'FASE_VOZ') {
          try { recognitionInstance.start(); } catch (_) {}
        }
      }, 1000);
    }
  };

  recognitionInstance.onerror = () => {
    if (estadoActual === 'FASE_VOZ') {
      try { recognitionInstance.start(); } catch (_) {}
    }
  };

  try { recognitionInstance.start(); } catch (_) {}
}

function abortarFaseVoz(mensaje) {
  if (recognitionInstance) {
    try { recognitionInstance.stop(); } catch (_) {}
    recognitionInstance = null;
  }
  clearTimeout(temporizadorVoz);
  actualizarInterfaz(mensaje, '#742a2a');

  setTimeout(() => {
    const displaySize = { width: video.clientWidth || 640, height: video.clientHeight || 480 };
    const faceMatcher = new faceapi.FaceMatcher(labeledFaceDescriptors, UMBRAL_DISTANCIA);
    iniciarEscaneoFacial(faceMatcher, displaySize);
  }, 2000);
}

function iniciarTimeoutReinicio(ms) {
  limpiarTimeoutReinicio();
  temporizadorInactividad = setTimeout(() => {
    contadorFallos = 0; 
    actualizarInterfaz('SISTEMA ACTIVO: Mire a la cámara para autenticar', '#1a365d');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, ms);
}

function limpiarTimeoutReinicio() {
  if (temporizadorInactividad) {
    clearTimeout(temporizadorInactividad);
    temporizadorInactividad = null;
  }
}

function dibujarRecuadro(ctx, box, color, etiqueta) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  ctx.fillStyle = color;
  ctx.font = 'bold 15px Arial';
  const textoAncho = ctx.measureText(etiqueta).width;
  ctx.fillRect(box.x, box.y - 25, textoAncho + 12, 25);

  ctx.fillStyle = '#ffffff';
  ctx.fillText(etiqueta, box.x + 6, box.y - 7);
}

function actualizarInterfaz(texto, colorFondo) {
  statusBox.innerText = texto;
  if (colorFondo) statusBox.style.backgroundColor = colorFondo;
}

function enviarAlESP32(caracter) {
  console.log(`[SALIDA COMANDO]: ${caracter}`);
  if (bluetoothCharacteristic) {
    const data = new TextEncoder().encode(caracter);
    bluetoothCharacteristic.writeValue(data).catch(console.error);
  }
}

window.onload = inicializar;