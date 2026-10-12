'use strict';

// Elementos de la interfaz y URL del KML indicado en ?kml=.
const statusElement = document.getElementById('status');
const gpsInfoElement = document.getElementById('gps-info');
const navigationButton = document.getElementById('btn-gmaps');
const routeUrl = new URLSearchParams(window.location.search).get('kml');

// Mapa, capa temporal para el progreso y estado compartido entre funciones.
const map = L.map('map', { zoomControl: false }).setView([25.8, -100.2], 12);
const routeProgressLayer = L.layerGroup().addTo(map);
let currentLocation = null;
let routeProgressUpdater = null;
let userMarker = null;

// Configura las capas y comienza la carga de la ruta y el seguimiento GPS.
initializeMapLayers();
loadRoute();
initializeGps();

// Agrega el control de zoom y permite cambiar entre los mapas base.
function initializeMapLayers() {
    L.control.zoom({ position: 'topright' }).addTo(map);

    const topoLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, attribution: 'Tiles &copy; Esri' }
    );
    const streetLayer = L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        { maxZoom: 19, attribution: '&copy; OpenStreetMap' }
    );
    const satelliteLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, attribution: 'Imagery &copy; Esri' }
    );
    // Referencias transparentes para mostrar calles, sus nombres y lugares sobre las imágenes.
    const roadLabelsLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, attribution: 'Roads &copy; Esri' }
    );
    const placeLabelsLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, attribution: 'Places &copy; Esri' }
    );
    const satelliteWithLabelsLayer = L.layerGroup([
        satelliteLayer,
        placeLabelsLayer,
        roadLabelsLayer
    ]).addTo(map);

    L.control.layers({
        '⛰️ Esri World Topo': topoLayer,
        '🗺️ Calles (OSM)': streetLayer,
        '🛰️ Satélite con nombres': satelliteWithLabelsLayer
    }, null, { position: 'topright' }).addTo(map);
}

// Descarga el KML de la URL y conecta sus eventos de carga y error.
function loadRoute() {
    if (!routeUrl) {
        statusElement.textContent = 'Sin parámetro ?kml=';
        return;
    }

    const routeStyle = L.geoJson(null, {
        style: () => ({ color: '#0142c8', weight: 6, opacity: 0.85 })
    });

    const kmlLayer = omnivore.kml(routeUrl, null, routeStyle)
        .on('ready', () => handleRouteReady(kmlLayer))
        .on('error', () => {
            statusElement.textContent = 'Error al descargar el KML';
            statusElement.style.color = '#c0392b';
        })
        .addTo(map);
}

// Ajusta el mapa a la ruta y prepara el progreso, los marcadores y la navegación.
function handleRouteReady(kmlLayer) {
    map.fitBounds(kmlLayer.getBounds(), { padding: [30, 30] });
    statusElement.textContent = 'Ruta Cargada Correctamente';
    statusElement.style.color = '#27ae60';

    const routePaths = getRoutePaths(kmlLayer);
    if (routePaths.length) {
        routeProgressUpdater = createRouteProgressUpdater(routePaths);
        routeProgressUpdater(currentLocation);
        addRouteMarkers(routePaths);
    }

    setNavigationDestination(kmlLayer.getBounds());
}

// Extrae las líneas del KML para poder dibujar y calcular el progreso por separado.
function getRoutePaths(kmlLayer) {
    const paths = [];

    kmlLayer.eachLayer((layer) => {
        if (!(layer instanceof L.Polyline) || layer instanceof L.Polygon) return;

        const linePaths = getLinePaths(layer.getLatLngs());
        if (linePaths.length) {
            paths.push(...linePaths);
            layer.setStyle({ opacity: 0 });
        }
    });

    return paths;
}

// Convierte las coordenadas, que pueden venir anidadas, en listas de líneas.
function getLinePaths(latlngs) {
    if (latlngs.length && latlngs[0] instanceof L.LatLng) {
        return latlngs.length > 1 ? [latlngs] : [];
    }

    return latlngs.flatMap(getLinePaths);
}

// Crea la función que redibuja la ruta según la ubicación actual del operador.
function createRouteProgressUpdater(routePaths) {
    return function updateRouteProgress(location) {
        routeProgressLayer.clearLayers();

        // Sin una ubicación GPS todavía, muestra toda la ruta como pendiente.
        if (!location) {
            routePaths.forEach((points) => addProgressLine(points, '#0142c8'));
            return;
        }

        const closest = findClosestRoutePoint(routePaths, location);
        const pendingPaths = [];

        // Colorea como recorridos los tramos anteriores y como pendientes los siguientes.
        routePaths.forEach((points, pathIndex) => {
            if (pathIndex < closest.pathIndex) {
                addProgressLine(points, '#75a6ef');
            } else if (pathIndex > closest.pathIndex) {
                addProgressLine(points, '#0142c8');
                pendingPaths.push(points);
            } else {
                const traveled = points.slice(0, closest.segmentIndex + 1).concat(closest.point);
                const remaining = [closest.point, ...points.slice(closest.segmentIndex + 1)];
                addProgressLine(traveled, '#75a6ef');
                addProgressLine(remaining, '#0142c8');
                pendingPaths.push(remaining);
            }
        });

        addRouteTrail(joinRoutePaths(pendingPaths));
    };
}

// Busca el punto más cercano de la ruta comparando coordenadas en píxeles del mapa.
function findClosestRoutePoint(routePaths, location) {
    const userPoint = map.latLngToLayerPoint(location);
    let closest = { distance: Infinity };

    routePaths.forEach((points, pathIndex) => {
        for (let segmentIndex = 0; segmentIndex < points.length - 1; segmentIndex++) {
            const start = map.latLngToLayerPoint(points[segmentIndex]);
            const end = map.latLngToLayerPoint(points[segmentIndex + 1]);
            const deltaX = end.x - start.x;
            const deltaY = end.y - start.y;
            const lengthSquared = deltaX * deltaX + deltaY * deltaY;
            // Proyecta la ubicación sobre el segmento y limita el resultado a sus extremos.
            const ratio = lengthSquared
                ? Math.max(0, Math.min(1,
                    ((userPoint.x - start.x) * deltaX + (userPoint.y - start.y) * deltaY) / lengthSquared))
                : 0;
            const nearestPoint = L.point(start.x + ratio * deltaX, start.y + ratio * deltaY);
            const distanceX = userPoint.x - nearestPoint.x;
            const distanceY = userPoint.y - nearestPoint.y;
            const distance = distanceX * distanceX + distanceY * distanceY;

            if (distance < closest.distance) {
                closest = {
                    distance,
                    pathIndex,
                    segmentIndex,
                    point: map.layerPointToLatLng(nearestPoint)
                };
            }
        }
    });

    return closest;
}

// Dibuja un tramo con el color indicado; Leaflet necesita al menos dos puntos.
function addProgressLine(points, color) {
    if (points.length < 2) return;

    L.polyline(points, { color, weight: 6, opacity: 0.85 }).addTo(routeProgressLayer);
}

// Une tramos pendientes contiguos para animar el recorrido como una sola línea.
function joinRoutePaths(paths) {
    return paths.reduce((route, points) => {
        if (route.length && route[route.length - 1].equals(points[0])) {
            route.push(...points.slice(1));
        } else {
            route.push(...points);
        }
        return route;
    }, []);
}

// Dibuja una línea blanca animada sobre el trayecto que aún falta recorrer.
function addRouteTrail(points) {
    if (points.length < 2) return;

    const trail = L.polyline(points, {
        color: '#ffffff',
        weight: 4,
        opacity: 1,
        className: 'route-trail',
        interactive: false
    }).addTo(routeProgressLayer);
    const trailElement = trail.getElement();
    if (!trailElement) return;

    const pathLength = trailElement.getTotalLength();
    if (!pathLength) return;

    const dashLength = Math.min(24, Math.max(12, pathLength * 0.025));
    const gapLength = dashLength * 0.8;
    const cycleLength = dashLength + gapLength;
    const duration = Math.max(0.8, Math.min(1.6, cycleLength / 10));
    const durationMs = duration * 1000;
    const startTime = performance.now() - (performance.now() % durationMs);
    // El patrón corto se repite para que haya varios guiones visibles en la ruta.
    trailElement.style.strokeDasharray = `${dashLength}px ${gapLength}px`;

    // Desplaza un ciclo completo del patrón para mantener una animación continua.
    function animate(timestamp) {
        if (!trailElement.isConnected) return;

        const progress = ((timestamp - startTime) % durationMs) / durationMs;
        trailElement.style.strokeDashoffset = `${-cycleLength * progress}px`;
        trailElement.style.opacity = (0.15 + 0.85 * Math.sin(Math.PI * progress)).toFixed(2);
        requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
}

// Coloca las marcas O y D en los extremos de la ruta extraída.
function addRouteMarkers(routePaths) {
    const origin = routePaths[0][0];
    const lastPath = routePaths[routePaths.length - 1];
    const destination = lastPath[lastPath.length - 1];

    addRouteMarker(origin, 'O', 'Origen', 'route-origin-icon');
    addRouteMarker(destination, 'D', 'Destino', 'route-destination-icon');
}

// Crea un marcador circular con letra y ventana emergente para un extremo.
function addRouteMarker(point, letter, label, className) {
    L.marker(point, {
        icon: L.divIcon({
            className: '',
            html: `<div class="route-icon ${className}" title="${label}">${letter}</div>`,
            iconSize: [36, 36],
            iconAnchor: [18, 18]
        })
    }).addTo(map).bindPopup(label);
}

// Configura el enlace para abrir Google Maps con el destino de la ruta.
function setNavigationDestination(bounds) {
    const destination = bounds.getSouthEast();
    navigationButton.href =
        `https://www.google.com/maps/dir/?api=1&destination=${destination.lat},${destination.lng}&travelmode=driving`;
    navigationButton.hidden = false;
}

// Activa el GPS continuo y actualiza el estado, el marcador y el progreso.
function initializeGps() {
    map.locate({ setView: false, watch: true, enableHighAccuracy: true });

    map.on('locationfound', (event) => {
        gpsInfoElement.textContent = 'GPS: Activo y Rastreando';
        currentLocation = event.latlng;
        if (routeProgressUpdater) routeProgressUpdater(currentLocation);

        // Crea el marcador la primera vez; después solo mueve el ya existente.
        if (!userMarker) {
            userMarker = L.circleMarker(event.latlng, {
                radius: 8,
                color: '#ffffff',
                fillColor: '#2980b9',
                fillOpacity: 1,
                weight: 3
            }).addTo(map).bindPopup('Ubicación del Operador');
        } else {
            userMarker.setLatLng(event.latlng);
        }
    });

    map.on('locationerror', () => {
        gpsInfoElement.textContent = 'GPS: No disponible o denegado';
    });
}