import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAudioMatcher } from './audio-matcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function slugify(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function loadCitiesConfig() {
  const configPath = path.join(projectRoot, 'cities.json');
  if (!fs.existsSync(configPath)) {
    console.error('Brak pliku cities.json w katalogu głównym projektu.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function parseProcessorArgs() {
  const args = process.argv.slice(2);
  let cityFilter = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--city' && args[i + 1]) {
      cityFilter = args[i + 1];
      i++;
    }
  }
  return { cityFilter };
}

// Parse CSV helper function - optimized with proper quote handling
function parseCSV(text) {
  // Normalize line endings and split
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  const result = [];
  
  for (let i = 1; i < lines.length; i++) {
    const currentline = parseCSVLine(lines[i]);
    if (currentline.length >= headers.length) {
      const obj = {};
      for (let j = 0; j < headers.length; j++) {
        obj[headers[j]] = currentline[j]?.trim() || '';
      }
      result.push(obj);
    }
  }
  return result;
}

// Parse a single CSV line with proper handling of quoted fields
function parseCSVLine(text) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current);
  return result;
}

function extractDirectionName(tripHeadsign) {
  // Extract direction from trip_headsign field
  // Format: "Poznań Główny" or "Żabinko/" or "MIŁOSTOWO"
  if (!tripHeadsign) return 'default';
  
  // Remove GTFS annotations like ^Y+, ^A,Y, ^B,Y etc.
  const clean = tripHeadsign.replace(/\^[A-Z,+]*/g, '').trim();
  
  // Split by / and get the first part (e.g., "Żabinko/" → "Żabinko")
  const parts = clean.split('/');
  return parts[0].trim() || 'default';
}

function parseDirectionNames(longName) {
  // Parse route_long_name into array of direction names
  // Format: "KIERUNEK1|KIERUNEK2" or just "KIERUNEK1"
  // The route_long_name contains direction patterns separated by |
  if (!longName) return [];
  
  // First, split by | to get the main segments
  const segments = longName.split('|');
  const directionNames = [];
  
  for (const segment of segments) {
    // For each segment, extract only the main direction pattern (before special annotations)
    const cleanSegment = segment
      .replace(/\^[^|]*/g, '') // Remove all ^ annotations
      .trim();
    
    // Check if this looks like a direction pattern (contains - or directional words)
    if (cleanSegment.length > 0 && 
        (cleanSegment.includes('-') || 
         cleanSegment.match(/\b(do|z|na|→|-)\b/i))) {
      directionNames.push(cleanSegment);
    }
  }
  
  return directionNames;
}

function getRouteTypeString(routeType) {
  // Convert GTFS route_type number to human-readable string
  const typeMap = {
    '0': 'TRAM',
    '1': 'METRO',
    '2': 'RAIL',
    '3': 'BUS',
    '4': 'TROLLEYBUS',
    '5': 'CABLE_CAR'
  };
  return typeMap[routeType] || 'BUS';
}

function normalizeLookupValue(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/\//g, ' ')
    .replace(/\s+/g, ' ');
}

function isOnDemandStopType(value) {
  const normalized = String(value ?? '').trim();
  return normalized === '2' || normalized === '3';
}

function isOnDemandStopTime(stopTime) {
  return isOnDemandStopType(stopTime?.pickup_type) || isOnDemandStopType(stopTime?.drop_off_type);
}

function parseRouteDescStops(routeDesc) {
  // Parse route_desc to get ordered list of stops/streets for each direction
  // Format: "STOP1 - Street1 - Street2 - STOP2^Annotation|STOP2 - Street3 - STOP1^Annotation"
  if (!routeDesc) return [];
  
  const directions = [];
  const segments = routeDesc.split('|');
  
  for (const segment of segments) {
    // Remove annotations starting from ^ to end of segment (or end of string)
    const cleanSegment = segment.split('^')[0].trim();
    
    if (!cleanSegment) continue;
    
    // Split by '-' and trim each part
    const stops = cleanSegment
      .split('-')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    
    if (stops.length > 0) {
      directions.push(stops);
    }
  }
  
  return directions;
}



async function processCity(cityConfig) {
  const slug = slugify(cityConfig.name);
  const dataDir = path.join(projectRoot, 'data', slug);
  const outputDir = path.join(projectRoot, 'public', 'dist', slug);

  console.log(`\n=== Przetwarzam: ${cityConfig.name} (${slug}) ===`);

  if (!fs.existsSync(dataDir)) {
    console.error(`  Brak katalogu danych: ${dataDir} — pomijam`);
    return;
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`Utworzono katalog: ${outputDir}`);
  }

  // Create audio matcher for this city
  const audioMatcher = createAudioMatcher({
    slug,
    dataDir,
    audioSource: cityConfig.audioSource || 'tts',
  });

  // Load CSV files
  console.log('Wczytuję dane GTFS...');
  try {
    const shapesText = fs.existsSync(path.join(dataDir, 'shapes.txt'))
      ? fs.readFileSync(path.join(dataDir, 'shapes.txt'), 'utf8') : '';
    const shapes = shapesText ? parseCSV(shapesText) : [];
    console.log(`  shapes.txt: ${shapes.length} rekordów`);

    const stopsText = fs.readFileSync(path.join(dataDir, 'stops.txt'), 'utf8');
    const stops = parseCSV(stopsText);
    console.log(`  stops.txt: ${stops.length} rekordów`);

    const tripsText = fs.readFileSync(path.join(dataDir, 'trips.txt'), 'utf8');
    const trips = parseCSV(tripsText);
    console.log(`  trips.txt: ${trips.length} rekordów`);

    const stopTimesText = fs.readFileSync(path.join(dataDir, 'stop_times.txt'), 'utf8');
    const stopTimes = parseCSV(stopTimesText);
    console.log(`  stop_times.txt: ${stopTimes.length} rekordów`);

    const routesText = fs.readFileSync(path.join(dataDir, 'routes.txt'), 'utf8');
    const routes = parseCSV(routesText);
    console.log(`  routes.txt: ${routes.length} rekordów`);

    const feedInfoText = fs.readFileSync(path.join(dataDir, 'feed_info.txt'), 'utf8');
    const feedInfo = parseCSV(feedInfoText);
    console.log(`  feed_info.txt: ${feedInfo.length} rekordów`);

    const calendarText = fs.existsSync(path.join(dataDir, 'calendar.txt'))
      ? fs.readFileSync(path.join(dataDir, 'calendar.txt'), 'utf8') : '';
    const calendar = calendarText ? parseCSV(calendarText) : [];
    console.log(`  calendar.txt: ${calendar.length} rekordów`);

    const calendarDatesText = fs.existsSync(path.join(dataDir, 'calendar_dates.txt'))
      ? fs.readFileSync(path.join(dataDir, 'calendar_dates.txt'), 'utf8') : '';
    const calendarDates = calendarDatesText ? parseCSV(calendarDatesText) : [];
    console.log(`  calendar_dates.txt: ${calendarDates.length} rekordów`);

    const agencyText = fs.existsSync(path.join(dataDir, 'agency.txt')) 
      ? fs.readFileSync(path.join(dataDir, 'agency.txt'), 'utf8') 
      : '';
    const agencies = agencyText ? parseCSV(agencyText) : [];
    console.log(`  agency.txt: ${agencies.length} rekordów`);

    // Build indexes for O(1) lookups
    console.log('Buduję indeksy...');
    const stopById = new Map(stops.map(s => [s.stop_id, s]));
    const routeById = new Map(routes.map(r => [r.route_id, r]));
    
    // Build agency_id -> agency_name mapping
    const agencyById = new Map(agencies.map(a => [a.agency_id, a]));
    
    // Build stop name -> stop mapping (multiple stops can have same name)
    const stopsByName = new Map();
    for (const stop of stops) {
      const normalizedName = normalizeLookupValue(stop.stop_name);
      if (!stopsByName.has(normalizedName)) {
        stopsByName.set(normalizedName, []);
      }
      stopsByName.get(normalizedName).push(stop);
    }
    
    // Build service_id -> schedule info map
    const serviceSchedule = new Map();
    for (const svc of calendar) {
      serviceSchedule.set(svc.service_id, {
        monday: svc.monday === '1',
        tuesday: svc.tuesday === '1',
        wednesday: svc.wednesday === '1',
        thursday: svc.thursday === '1',
        friday: svc.friday === '1',
        saturday: svc.saturday === '1',
        sunday: svc.sunday === '1',
        start_date: svc.start_date,
        end_date: svc.end_date
      });
    }
    
    // Add calendar_dates exceptions
    const serviceExceptions = new Map();
    for (const exc of calendarDates) {
      if (!serviceExceptions.has(exc.service_id)) {
        serviceExceptions.set(exc.service_id, []);
      }
      serviceExceptions.get(exc.service_id).push({
        date: exc.date,
        exception_type: exc.exception_type // 1 = added, 2 = removed
      });
    }
    
    // Get feed info for metadata
    const feedMetadata = feedInfo.length > 0 ? {
      feed_start_date: feedInfo[0].feed_start_date,
      feed_end_date: feedInfo[0].feed_end_date,
      feed_publisher_name: feedInfo[0].feed_publisher_name,
      feed_publisher_url: feedInfo[0].feed_publisher_url
    } : null;
    
    // Get service info for metadata
    const serviceMetadata = {
      services_count: serviceSchedule.size,
      exceptions_count: calendarDates.length,
      services: Object.fromEntries(serviceSchedule)
    };
    
    // Index stop_times by trip_id for fast lookup
    const stopTimesByTrip = new Map();
    for (const st of stopTimes) {
      if (!stopTimesByTrip.has(st.trip_id)) {
        stopTimesByTrip.set(st.trip_id, []);
      }
      stopTimesByTrip.get(st.trip_id).push(st);
    }

    // Group shapes by shape_id
    const shapesByRoute = new Map();
    for (const shape of shapes) {
      const id = shape.shape_id;
      if (!shapesByRoute.has(id)) {
        shapesByRoute.set(id, []);
      }
      shapesByRoute.get(id).push(shape);
    }

    // Sort shapes by sequence
    for (const [id, shapesList] of shapesByRoute) {
      shapesList.sort((a, b) => parseInt(a.shape_pt_sequence) - parseInt(b.shape_pt_sequence));
    }

    // Group trips by route_id
    const tripsByRoute = new Map();
    for (const trip of trips) {
      const routeId = trip.route_id;
      if (!tripsByRoute.has(routeId)) {
        tripsByRoute.set(routeId, []);
      }
      tripsByRoute.get(routeId).push(trip);
    }

    // For each route, collect all directions and their data
    const routeData = [];
    const audioMatchingStats = {
      totalStops: 0,
      matchedStops: 0,
      unmatchedStops: 0,
      strategies: {
        exception: 0,
        locationSlash: 0,
        locationOnly: 0,
        cityPrefix: 0,
        poznanPrefix: 0,
        partialMatch: 0
      }
    };

    for (const [routeId, routeTrips] of tripsByRoute) {
      // Find route info - O(1) lookup
      const routeInfo = routeById.get(routeId);
      if (!routeInfo) continue;
      
      // Parse direction names from route_long_name (contains direction patterns like "A - B|B - A")
      const directionNames = parseDirectionNames(routeInfo.route_long_name);
      
      // Parse route_desc to get ordered stops for each direction
      const routeDescDirections = parseRouteDescStops(routeInfo.route_desc);
      
      // Group trips by direction.
      // When trip_headsign is present (Poznań), group by headsign and filter
      // against route_long_name. When headsign is empty (Gorzów), group by
      // direction_id and use route_long_name as the direction name.
      const hasHeadsign = routeTrips.some(t => t.trip_headsign && t.trip_headsign.trim());
      const directions = new Map();
      const onDemandStatsByStopId = new Map();

      if (hasHeadsign) {
        // Poznań path: group by headsign, filter against official direction names
        for (const trip of routeTrips) {
          const directionName = extractDirectionName(trip.trip_headsign);

          const isOfficialDirection = directionNames.some(officialName => {
            const officialClean = officialName.replace(/\^[^|]*/g, '').trim();
            const officialLower = normalizeLookupValue(officialClean);
            const directionLower = normalizeLookupValue(directionName);

            if (officialClean.includes(' - ')) {
              const parts = officialClean.split(' - ').map(p => normalizeLookupValue(p));
              const origin = parts[0];
              const destination = parts[parts.length - 1];
              return origin === directionLower ||
                     destination === directionLower ||
                     officialLower.includes(directionLower) ||
                     directionLower.includes(origin) ||
                     directionLower.includes(destination);
            }
            return officialLower === directionLower ||
                   officialLower.includes(directionLower) ||
                   directionLower.includes(officialLower);
          });

          if (isOfficialDirection) {
            if (!directions.has(directionName)) {
              directions.set(directionName, []);
            }
            directions.get(directionName).push(trip);

            const tripStopTimes = stopTimesByTrip.get(trip.trip_id) || [];
            for (const stopTime of tripStopTimes) {
              const stopId = stopTime.stop_id;
              const currentStats = onDemandStatsByStopId.get(stopId) || { total: 0, onDemand: 0 };
              currentStats.total += 1;
              if (isOnDemandStopTime(stopTime)) {
                currentStats.onDemand += 1;
              }
              onDemandStatsByStopId.set(stopId, currentStats);
            }
          }
        }
      } else {
        // Gorzów path: no headsign — group by direction_id, use route_long_name
        for (const trip of routeTrips) {
          const dirKey = trip.direction_id || '0';
          if (!directions.has(dirKey)) {
            directions.set(dirKey, []);
          }
          directions.get(dirKey).push(trip);

          const tripStopTimes = stopTimesByTrip.get(trip.trip_id) || [];
          for (const stopTime of tripStopTimes) {
            const stopId = stopTime.stop_id;
            const currentStats = onDemandStatsByStopId.get(stopId) || { total: 0, onDemand: 0 };
            currentStats.total += 1;
            if (isOnDemandStopTime(stopTime)) {
              currentStats.onDemand += 1;
            }
            onDemandStatsByStopId.set(stopId, currentStats);
          }
        }
      }

      const isStopOnDemand = (stopId) => {
        const stats = onDemandStatsByStopId.get(stopId);
        if (!stats || stats.total === 0) return false;
        return (stats.onDemand / stats.total) >= 0.5;
      };

      // For each direction, collect unique shape_id and stops
      const directionsData = [];
      
      // Create a map of destination -> direction_name for matching
      // Format: "MIŁOSTOWO - GÓRCZYN PKM" means destination is "GÓRCZYN PKM"
      const directionNameMap = new Map();
      for (const dirName of directionNames) {
        const parts = dirName.split(' - ');
        if (parts.length >= 2) {
          const destination = parts[parts.length - 1].trim(); // Last part is destination
          directionNameMap.set(normalizeLookupValue(destination), dirName);
        }
      }
      
      // Also create a map of direction_name -> expected stops from route_desc
      const directionNameToStopsMap = new Map();
      for (let i = 0; i < routeDescDirections.length; i++) {
        const dirDesc = routeDescDirections[i];
        if (dirDesc.length > 0) {
          // Get the destination (last stop) from route_desc
          const destination = normalizeLookupValue(dirDesc[dirDesc.length - 1]);
          directionNameToStopsMap.set(destination, dirDesc);
        }
      }
      
      for (const [direction, dirTrips] of directions) {
        // Get unique shape_ids for this direction and count their frequency
        const shapeFrequency = new Map();
        for (const trip of dirTrips) {
          const shapeId = trip.shape_id;
          shapeFrequency.set(shapeId, (shapeFrequency.get(shapeId) || 0) + 1);
        }
        
        // Filter out invalid shapes (like "0")
        const validShapeIds = [...shapeFrequency.keys()].filter(id => id !== "0" && id !== "" && shapesByRoute.has(id));
        
        // Select the most frequently used shape - likely the main route pattern
        let shapeId = null;
        if (validShapeIds.length > 0) {
          let maxFrequency = 0;
          for (const id of validShapeIds) {
            const freq = shapeFrequency.get(id);
            if (freq > maxFrequency) {
              maxFrequency = freq;
              shapeId = id;
            }
          }
        } else if (validShapeIds.length > 0) {
          // Fallback to first shape if no valid shapes found
          shapeId = validShapeIds[0];
        }
        
        const shapePoints = shapesByRoute.get(shapeId) || [];
        
        // Get lat/lng array for the route line
        const latlngs = shapePoints.map(p => [
          parseFloat(p.shape_pt_lat),
          parseFloat(p.shape_pt_lon)
        ]);

        // Find direction index to get expected stop names from route_desc
        const directionIndex = [...directions.keys()].indexOf(direction);
        const expectedStopNamesFromDescByIndex = routeDescDirections[directionIndex] || [];
        
        // Find the trip whose stop_times best match the expected stops from route_desc
        let bestTrip = null;
        let bestMatchScore = -1;
        
        // Get the expected first stop name from route_desc based on destination
        // The destination in route_desc should match the trip_headsign (direction)
        const expectedStopNamesFromDesc = directionNameToStopsMap.get(normalizeLookupValue(direction)) || expectedStopNamesFromDescByIndex || [];
        const expectedFirstStopName = expectedStopNamesFromDesc.length > 0 ? normalizeLookupValue(expectedStopNamesFromDesc[0]) : null;
        
        for (const trip of dirTrips) {
          const tripStopTimes = stopTimesByTrip.get(trip.trip_id) || [];
          const tripStopIds = tripStopTimes.map(st => st.stop_id);
          
          // Count how many expected stops from route_desc are in this trip
          let matchScore = 0;
          for (const expectedName of expectedStopNamesFromDesc) {
            const normalizedName = normalizeLookupValue(expectedName);
            const matchingStops = stopsByName.get(normalizedName);
            if (matchingStops) {
              for (const stop of matchingStops) {
                if (tripStopIds.includes(stop.stop_id)) {
                  matchScore++;
                  break;
                }
              }
            }
          }
          
          // Check if the first stop matches the expected first stop from route_desc
          let firstStopBonus = 0;
          if (expectedFirstStopName && tripStopTimes.length > 0) {
            // Sort stop times to get the first one
            const sortedStops = [...tripStopTimes].sort((a, b) => 
              parseInt(a.stop_sequence) - parseInt(b.stop_sequence)
            );
            const firstStopId = sortedStops[0].stop_id;
            const firstStop = stopById.get(firstStopId);
            if (firstStop) {
              const firstStopName = normalizeLookupValue(firstStop.stop_name);
              // Check if first stop name contains expected name or vice versa
              if (firstStopName === expectedFirstStopName || 
                  firstStopName.includes(expectedFirstStopName) || 
                  expectedFirstStopName.includes(firstStopName)) {
                // Big bonus for matching first stop - this ensures we get the correct origin
                firstStopBonus = 10000;
              }
            }
          }
          
          // Prefer trips with more stops (more complete route)
          const totalStops = tripStopTimes.length;
          const combinedScore = firstStopBonus + (matchScore * 100) + totalStops;
          
          if (combinedScore > bestMatchScore) {
            bestMatchScore = combinedScore;
            bestTrip = trip;
          }
        }
        
        // Use the best matching trip to get stops
        const routeStops = [];
        if (bestTrip) {
          const tripStopTimes = stopTimesByTrip.get(bestTrip.trip_id) || [];
          const sortedStopTimes = [...tripStopTimes].sort((a, b) => 
            parseInt(a.stop_sequence) - parseInt(b.stop_sequence)
          );
          
          for (const stopTime of sortedStopTimes) {
            const stop = stopById.get(stopTime.stop_id);
            if (stop) {
              audioMatchingStats.totalStops++;

              // Resolve audio_id via audio-matcher
              const rawStopName = String(stop.stop_name || '');
              const match = audioMatcher.find(rawStopName);
              let audioId;
              if (match) {
                audioId = match.audio_id;
                audioMatchingStats.matchedStops++;
                if (match.strategy && audioMatchingStats.strategies[match.strategy] !== undefined) {
                  audioMatchingStats.strategies[match.strategy]++;
                }
              } else {
                audioId = null;
                audioMatchingStats.unmatchedStops++;
              }

              const stopDemandStats = onDemandStatsByStopId.get(stop.stop_id);
              const isOnDemand = stopDemandStats
                ? (stopDemandStats.onDemand / stopDemandStats.total) >= 0.5
                : false;

              routeStops.push({
                stop_id: stop.stop_id,
                stop_name: stop.stop_name.replace(/"/g, ''),
                stop_lat: parseFloat(stop.stop_lat),
                stop_lon: parseFloat(stop.stop_lon),
                stop_code: stop.stop_code,
                stop_sequence: parseInt(stopTime.stop_sequence),
                is_on_demand: isOnDemand,
                audio_id: audioId
              });
            }
          }
        }
        
        // Skip directions without stops
        if (routeStops.length === 0) {
          continue;
        }

        // Resolve direction_name: try map lookup, then fallback chain
        let directionName = directionNameMap.get(normalizeLookupValue(direction));

        if (!directionName) {
          // For no-headsign feeds (Gorzów), direction is a direction_id like '0'/'1'.
          // Use route_long_name as the direction name (e.g. "A - B").
          if (!hasHeadsign && directionNames.length > 0) {
            directionName = directionNames[directionIndex] || directionNames[0];
          } else {
            directionName = directionNames[directionIndex] || dirTrips[0]?.trip_headsign || direction;
          }
        }

        // Calculate bounds more efficiently
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        for (const [lat, lng] of latlngs) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
        }

        directionsData.push({
          direction: routeStops.length > 0 ? routeStops[routeStops.length - 1].stop_name : direction,
          direction_name: directionName,
          shape_id: shapeId,
          shape: {
            coordinates: latlngs,
            bounds: { minLat, maxLat, minLng, maxLng }
          },
          stops: routeStops,
          stop_count: routeStops.length,
          service_ids: [...new Set(dirTrips.map(t => t.service_id))],
          trip_count: dirTrips.length,
          shape_frequency: shapeFrequency.get(shapeId)
        });
      }

      // Build route object with all directions
      const routeObj = {
        route_id: routeId,
        short_name: routeInfo.route_short_name,
        color: routeInfo.route_color,
        text_color: routeInfo.route_text_color,
        type: getRouteTypeString(routeInfo.route_type),
        agency_name: routeInfo.agency_id ? (agencyById.get(routeInfo.agency_id)?.agency_name || 'Nieznana agencja') : 'Nieznana agencja',
        feed_info: feedMetadata,
        directions: directionsData
      };

      const totalStops = directionsData.reduce((sum, d) => sum + d.stops.length, 0);
      
      routeData.push(routeObj);
      
      // Write to file (one file per route with all directions)
      const outputFile = path.join(outputDir, `${routeId}.json`);
      fs.writeFileSync(outputFile, JSON.stringify(routeObj, null, 2), 'utf8');
      console.log(`  Zapisano: ${outputFile} (${directions.size} kierunki, ${totalStops} przystanków)`);
    }

    console.log('\nStatystyki dopasowania audio_id:');
    console.log(`  przystanki: ${audioMatchingStats.totalStops}`);
    console.log(`  dopasowane: ${audioMatchingStats.matchedStops}`);
    console.log(`  brak dopasowania: ${audioMatchingStats.unmatchedStops}`);
    for (const [strategyName, count] of Object.entries(audioMatchingStats.strategies)) {
      console.log(`  ${strategyName}: ${count}`);
    }

    // Write routes index
    const routesList = routeData.map(r => ({
      route_id: r.route_id,
      short_name: r.short_name,
      color: r.color,
      text_color: r.text_color,
      type: r.type,
      agency_name: r.agency_name,
      direction_count: r.directions.length,
      total_stops: r.directions.reduce((sum, d) => sum + d.stops.length, 0),
      feed_info: r.feed_info
    }));
    
    const indexFile = path.join(outputDir, 'routes.json');
    fs.writeFileSync(indexFile, JSON.stringify(routesList, null, 2), 'utf8');
    console.log(`\nGotowe! Zapisano ${routeData.length} linii w katalogu: ${outputDir}`);
    console.log(`Indeks linii: ${indexFile}`);
  } catch (err) {
    console.error('Błąd skryptu:', err);
    process.exitCode = 1;
  }
}

async function main() {
  const { cityFilter } = parseProcessorArgs();
  const config = loadCitiesConfig();

  let cities = config.cities;
  if (cityFilter) {
    cities = cities.filter(c => slugify(c.name) === cityFilter);
    if (cities.length === 0) {
      console.error(`Nie znaleziono miasta o slug: "${cityFilter}"`);
      console.error('Dostępne:', config.cities.map(c => slugify(c.name)).join(', '));
      process.exit(1);
    }
  }

  for (const city of cities) {
    await processCity(city);
  }

  // Write frontend cities.json in dist root
  const distDir = path.join(projectRoot, 'public', 'dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }
  const frontendCities = config.cities.map(c => {
    const entry = {
      name: c.name,
      slug: slugify(c.name),
      audioSource: c.audioSource || 'tts',
      ttsLang: c.ttsLang || 'pl-PL',
    };
    if (c.audioBaseUrl) entry.audioBaseUrl = c.audioBaseUrl;
    return entry;
  });
  fs.writeFileSync(
    path.join(distDir, 'cities.json'),
    JSON.stringify(frontendCities, null, 2),
    'utf8',
  );
  console.log(`\nZapisano konfigurację miast: ${distDir}/cities.json`);
}

main();
