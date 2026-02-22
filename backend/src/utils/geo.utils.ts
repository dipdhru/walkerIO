/**
 * Geospatial utility functions for Walker.IO
 * All coordinates are [longitude, latitude] (GeoJSON standard)
 */

export interface GpsPoint {
  latitude: number;
  longitude: number;
  altitude?: number;
  accuracy?: number;
  timestamp: number;
  speed?: number; // m/s reported by device
}

export interface GeoJsonPoint {
  type: 'Point';
  coordinates: [number, number]; // [lng, lat]
}

export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: [number, number][][];
}

/**
 * Haversine formula — returns distance in meters between two GPS points
 */
export function haversineDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371000; // Earth radius in meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Calculate speed in km/h between two GPS points
 */
export function calculateSpeed(p1: GpsPoint, p2: GpsPoint): number {
  const distanceMeters = haversineDistance(
    p1.latitude, p1.longitude,
    p2.latitude, p2.longitude
  );
  const timeDeltaSeconds = (p2.timestamp - p1.timestamp) / 1000;
  if (timeDeltaSeconds <= 0) return 0;
  return (distanceMeters / timeDeltaSeconds) * 3.6; // m/s → km/h
}

/**
 * Convert GPS points array to GeoJSON Polygon using simplified convex hull
 * For MVP — production should use turf.js alpha shapes for concave territory
 */
export function gpsPointsToPolygon(points: GpsPoint[]): GeoJsonPolygon | null {
  if (points.length < 3) return null;

  const coords: [number, number][] = points.map(p => [p.longitude, p.latitude]);

  // Convex hull using Graham scan
  const hull = convexHull(coords);
  if (hull.length < 3) return null;

  // Close the ring
  hull.push(hull[0]);

  return {
    type: 'Polygon',
    coordinates: [hull],
  };
}

/**
 * Graham scan convex hull — O(n log n)
 */
function convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;

  // Find bottom-left point
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    if (
      points[i][1] < points[start][1] ||
      (points[i][1] === points[start][1] && points[i][0] < points[start][0])
    ) {
      start = i;
    }
  }

  const pivot = points[start];
  const sorted = points
    .filter((_, i) => i !== start)
    .sort((a, b) => {
      const angleA = Math.atan2(a[1] - pivot[1], a[0] - pivot[0]);
      const angleB = Math.atan2(b[1] - pivot[1], b[0] - pivot[0]);
      return angleA - angleB;
    });

  const hull: [number, number][] = [pivot];

  for (const point of sorted) {
    while (hull.length >= 2) {
      const cross = crossProduct(hull[hull.length - 2], hull[hull.length - 1], point);
      if (cross <= 0) hull.pop();
      else break;
    }
    hull.push(point);
  }

  return hull;
}

function crossProduct(O: [number, number], A: [number, number], B: [number, number]): number {
  return (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
}

/**
 * Encode a lat/lng to a geohash prefix for geographic room routing
 * Precision 3 ≈ 78km × 78km (used for WebSocket rooms — coarser)
 * Precision 4 ≈ 20km × 20km (used for territory spatial queries)
 */
export function toGeohash(lat: number, lng: number, precision = 4): string {
  const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let minLat = -90, maxLat = 90;
  let minLng = -180, maxLng = 180;
  let hash = '';
  let bits = 0;
  let even = true;
  let code = 0;

  while (hash.length < precision) {
    if (even) {
      const mid = (minLng + maxLng) / 2;
      if (lng > mid) { code = (code << 1) | 1; minLng = mid; }
      else { code = code << 1; maxLng = mid; }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (lat > mid) { code = (code << 1) | 1; minLat = mid; }
      else { code = code << 1; maxLat = mid; }
    }
    even = !even;
    bits++;
    if (bits === 5) {
      hash += BASE32[code];
      code = 0;
      bits = 0;
    }
  }
  return hash;
}

/**
 * Convert area from square degrees to approximate square meters
 * (PostGIS does this properly with ::geography cast — this is for client-side estimates)
 */
export function sqDegreesToM2(sqDegrees: number, latitude: number): number {
  const latMeters = 111320;
  const lngMeters = 111320 * Math.cos((latitude * Math.PI) / 180);
  return sqDegrees * latMeters * lngMeters;
}

/**
 * Format area for display
 */
export function formatArea(areaM2: number): string {
  if (areaM2 >= 1_000_000) return `${(areaM2 / 1_000_000).toFixed(2)} km²`;
  if (areaM2 >= 10_000) return `${(areaM2 / 10_000).toFixed(1)} ha`;
  return `${Math.round(areaM2)} m²`;
}
