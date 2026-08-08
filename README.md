# Zbiorkomapa

Zbiorkomapa to interaktywna wizualizacja tras komunikacji miejskiej. Projekt łączy dane GTFS z mapą, umożliwiając przeglądanie linii, wyboru kierunku oraz analizę tras i przystanków. Obsługuje wiele miast — obecnie Poznań i Świnoujście.

## Demo

Wypróbuj: [Zbiorkomapa](https://danielmroczek.github.io/zbiorkomapa/)

## Najważniejsze funkcje

- obsługa wielu miast (Poznań, Świnoujście) z łatwą możliwością dodawania kolejnych
- przeglądanie tras tramwajowych i autobusowych
- wybór linii oraz kierunku jazdy
- podgląd długości trasy i liczby przystanków
- odtwarzanie nagrań głosowych dla przystanków (miasta z nagraniami) lub TTS (miasta bez nagrań)
- **przejazd automatyczny** — animacja pojazdu wzdłuż trasy z ogłoszeniami głosowymi na przystankach (Spacja lub przycisk ▶)
- gotowy układ do druku i prezentacji

## Dodawanie nowego miasta

1. Dodaj wpis do `cities.json` w katalogu głównym projektu:
   ```json
   {
     "name": "Nazwa Miasta",
     "gtfsUrl": "https://example.com/gtfs.zip",
     "audioSource": "tts",
     "ttsLang": "pl-PL"
   }
   ```
2. Uruchom `npm run build` — dane zostaną pobrane i przetworzone automatycznie.
3. Jeśli miasto ma nagrania głosowe, ustaw `"audioSource": "recordings"` i dodaj `"audioBaseUrl"`.

## Skrypty

- `npm run download` — pobiera pliki GTFS dla wszystkich miast (lub `--city slug` dla jednego)
- `npm run download:audio` — pobiera mapowania nagrań głosowych dla Poznania
- `npm run process` — przetwarza dane i przygotowuje zasoby dla aplikacji
- `npm run build` — pobiera i przetwarza wszystko (`download` + `download:audio` + `process`)

## Struktura projektu

- `cities.json` — konfiguracja miast (GTFS URL, audio source, TTS lang)
- `data/{city-slug}/` — pliki GTFS oraz mapowania audio per miasto
- `public/dist/{city-slug}/` — wygenerowane dane tras per miasto
- `public/dist/cities.json` — konfiguracja miast dla frontendu
- `public/` — frontend oraz zasoby statyczne
- `scripts/` — skrypty pobierające i przetwarzające dane
  - `scripts/processor.js` — przetwarza GTFS na zasoby frontendu (oparty o bibliotekę [`gtfs`](https://github.com/BlinkTagInc/node-gtfs)); grupowanie tras wg `direction_id`
  - `scripts/audio-matcher.js` — samodzielny moduł dopasowujący przystanki do nagrań audio (per miasto; obecnie Poznań)
  - `scripts/osrm-router.js` — samodzielny moduł wyznaczający trasy drogowe (gdy GTFS nie ma shapes)

## Uwagi o instalacji

`gtfs` zależy od `better-sqlite3`, w `package.json` wymuszono (przez `overrides`) wersję
`12.4.1`, która ma prekompilowane binaria — dzięki temu `npm install` działa bez narzędzi
buildowych (lokalnie na Windows oraz w GitHub Actions). Procesor importuje GTFS do
per-miastowego cache SQLite (`data/{slug}/gtfs-cache.sqlite`, ignorowany przez git);
konfigurację node-gtfs generuje sam z `cities.json` (bez dodatkowego pliku config).

## Pola audio w danych

- Dla miast z nagraniami (`audioSource: "recordings"`, obecnie Poznań) każdy przystanek ma
  pole `audio_id`: identyfikator nagrania albo `null`, gdy nie ma nagrania dla tego przystanku.
- Dla miast TTS (`audioSource: "tts"`) pole `audio_id` jest **pomijane** — frontend używa
  zamiany tekstu na mowę (`stop_name`).