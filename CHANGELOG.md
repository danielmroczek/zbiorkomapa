# CHANGELOG

Wszystkie istotne zmiany w projekcie Zbiorkomapa, pogrupowane według daty.

## 2026-09-26

- Nawigacja strzałkami (←/→) działa teraz w dwóch fazach: trzymanie klawisza tylko przelatuje numerami linii w panelu (bez przeładowywania trasy na mapie), a właściwe załadowanie następuje po puszczeniu klawisza. Naprawiono też migający kolor plakietki linii podczas szybkiego przełączania.

## 2026-09-24

- Dodano miasto Nowy Tomyśl (ogłoszenia w TTS, pl-PL), wraz z aktualizacją dokumentacji.

## 2026-09-14

- Uproszczono kod SVG favicon przez scalenie ścieżek.

## 2026-09-13

- Panel informacyjny pokazuje daty obowiązywania rozkładu (ważności) linii; etykieta przeniesiona do szablonu HTML.

## 2026-09-12

- Poprawka: combobox linii/kierunku traci fokus po zmianie wyboru, żeby spacja nie otwierała listy ponownie.

## 2026-09-06 → 2026-09-05

- Rozbudowa wyjątków rozwijania skrótów dla TTS (lepsza wymowa skróconych nazw przystanków, m.in. „OS.", „al.") i testy jednostkowe rozwijania skrótów.

## 2026-09-04

- Per-miasto konfiguracja głośności nagrań audio, wykorzystywana przez odtwarzacz.

## 2026-08-27

- Wydzielono składanie linii GTFS (grupowanie kierunków, merge linii, kształty) do samodzielnego modułu `route-assembler.js`.

## 2026-08-26

- Stylizacja podpowiedzi klawiaturowych (dostępność).

## 2026-08-25

- Wydzielono maszynę stanu jazdy do modułu `ride-core` (wznowienie przerwanych odcinków, kontrola postępu jazdy) wraz z testami.

## 2026-08-21 → 2026-08-19

- Nazwy kierunków pętli oznaczane strzałką ↻ z przystankiem końcowym.
- Poprawka dopasowania audio dla Jeziory Wielkie (kolejność normalizacji wyrażeń, dopasowanie po samej miejscowości) — nowe testy przypadków brzegowych (Luboń/Kurowskiego, wielkość liter i spacje).

## 2026-08-18

- Etykiety kierunków: krótsza forma (`Pierwsza → Ostatnia`), rozwijana do pełnej przy niejednoznaczności.
- Dane kierunków używają pól `first_stop`/`last_stop` zamiast sztywnych nazw kierunków.
- Logika Alpine.js przeniesiona z HTML do osobnych plików JS; sanitizacja danych GTFS w procesorze, `displayName` i etykieta play/pauzy.

## 2026-08-17

- Zestaw testów (vitest) walidujących wyjście procesora GTFS.

## 2026-08-16

- Cofnięto niestabilne zmiany procesora i przywrócono grupowanie kierunków na bazie node-gtfs.

## 2026-08-15

- Dopasowanie audio działa bezpośrednio w procesorze (audio-matcher podpięty do pipeline'u), przystanki bez nagrania dostają `audio_id: null` zamiast fałszywego trafienia.
- Procesor generuje per-miasto katalog wyjściowy i frontendowy `public/dist/cities.json`.
- Testy jednostkowe strategii dopasowania audio dla Poznania.

## 2026-08-14

- Dokumentacja domenowa (CONTEXT.md, ADR) i wytyczne issue trackera dla agentów.

## 2026-08-13

- Hybrydowe odtwarzanie audio: gdy brak nagrania dla przystanku, używa TTS.

## 2026-08-12

- Uporządkowanie Turf: `turf.length` do długości trasy, `turf.earthRadius` do przeliczania zoomu.

## 2026-08-11

- Wydzielenie czystych obliczeń jazdy do modułu `ride-math` wraz z testami.

## 2026-08-10 → 2026-08-09

- Podział frontendu na mniejsze pliki JS; migracja Leaflet i Turf z CDN do importów ESM.
- Animacja jazdy: wznawianie od przerwanego odcinka dojazdu do przystanku.
- Wcześniej policzone azymuty i odległości odcinków trasy (płynne kierowanie pojazdu w animacji).
- Gorzów Wielkopolski: dokumentacja i logika procesora łącząca wiele `route_id` w jedną linię; wydzielenie audio-matcher do osobnego modułu.
- Procesor przetworzony na node-gtfs (koniec z własnym parserem GTFS).
- Przyciąganie pierwszego przystanku tylko do pierwszej połowy trasy; pozycja markera na najbliższym punkcie trasy.

## 2026-08-08 → 2026-08-07

- Gorzów Wielkopolski jako trzecie miasto: dane w `cities.json`, wsparcie w procesorze i frontendzie.
- Panel tras scrollowalny i responsywny; layout kontrolek jazdy uporządkowany.
- CSS w osobnym arkuszu (`styles.css`) z użyciem natywnego zagnieżdżania CSS.
- Regulacja prędkości animacji jazdy.
- Modal pomocy opisujący obsługę aplikacji; poprawa układu mapy i panelu.

## 2026-08-06 → 2026-08-05

- Obsługa kolorów tras w procesorze (kolory per miasto i kierunek).
- Wsparcie wielu miast: Poznań i Świnoujście, wybór miasta w UI.
- Fallback trasowania przez OSRM dla miast bez GTFS shapes; jeden request na trasę zamiast per segment.

## 2026-08-04

- Osobne sterowanie odgłosami silnika i ogłoszeniami głosowymi przystanków.

## 2026-08-03

- Podświetlanie aktualnego przystanku podczas jazdy.

## 2026-08-02

- Ikona pojazdu obraca się wg azymutu jazdy.
- Grubszy ślad jazdy na mapie (lepsza widoczność).
- Usunięcie emoji z ikony typu linii w panelu.

## 2026-08-01

- Funkcja „auto-jazdy": odtwarzanie symulowanego przejazdu (uruchamianie, pauza, wznawianie), auto-zoom dopasowany do przeciętnej odległości między przystankami, poprawne cięcie śladu jazdy (`turf.lineSliceAlong`).
- README dopisuje auto-jazdę.

## 2026-07-17

- Nowy skrypt `analyzeAudioDescriptions.js`: transkrypcja (ASR) plików MP3 ogłoszeń i weryfikacja jakości względem opisu przystanku (dystans Levenshteina), wyniki do `data/audio-analysis-results.csv`.

## 2026-07-14

- Strefy linii A/B/C/D na mapie (kolor strefy w CSS, znaczniki przystanków z literą strefy), zapamiętywanie ostatniego kierunku w `localStorage`, font Roboto.

## 2026-07-10

- Nowy skrypt `checkAudioLinks.js`: równoległa weryfikacja dostępności plików MP3 ogłoszeń ZTM (linki poskładane z `audio.csv`).

## 2026-07-09

- Seria iteracyjnych poprawek dopasowywania nagrań głosowych do przystanków:
  - wspólna funkcja normalizacji `(lowercase, trim, kolejność miejscowość|nazwa)`,
  - nowe strategie dopasowania: pary „miejscowość/nazwa" (np. „Szalchet/Serbska"), same lokalizacje (wsie bez nazwy przystanku, np. „Szlachcin"),
  - wyjątki ręczne (m.in. „Św. Marcin", „Wilczak/Serbska"), domyślne `audio_id` dla niedopasowanych przystanków,
  - przystanki „na żądanie": `is_on_demand`, gdy ≥50% przejazdów zaznacza `pickup_type`/`drop_off_type` jako na żądanie (reguła GTFS),
  - dynamiczny wygląd badge'a linii w frontendzie (kolory wg typu).

## 2026-07-03

- Commit inicjalny: aplikacja frontendowa (mapa Leaflet + Alpine.js), procesor GTFS, pobieranie danych, mapowania audio dla Poznania, deploy na GitHub Pages, licencja MIT, README.
