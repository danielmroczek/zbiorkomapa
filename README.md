# Zbiorkomapa

Zbiorkomapa to interaktywna wizualizacja tras komunikacji miejskiej w Poznaniu. Projekt łączy dane GTFS z mapą, umożliwiając przeglądanie linii, wyboru kierunku oraz analizę tras i przystanków.

## Demo

Wypróbuj: [Zbiorkomapa](https://danielmroczek.github.io/zbiorkomapa/)

## Najważniejsze funkcje

- przeglądanie tras tramwajowych i autobusowych
- wybór linii oraz kierunku jazdy
- podgląd długości trasy i liczby przystanków
- odtwarzanie nagrań głosowych dla przystanków
- gotowy układ do druku i prezentacji

## Skrypty

- `npm run download` — pobiera pliki GTFS z ZTM Poznań
- `npm run download-audio` — pobiera mapowania nagrań głosowych do pliku `data/audio.csv`
- `npm run process` — przetwarza dane i przygotowuje zasoby dla aplikacji

## Struktura projektu

- `data/` — pliki GTFS oraz mapowania audio
- `public/` — frontend oraz zasoby statyczne
- `scripts/` — skrypty pobierające i przetwarzające dane