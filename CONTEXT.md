# CONTEXT — Zbiorkomapa

Słownik pojęć domeny. Bez szczegółów implementacyjnych — to glosariusz, nie spec.

## Miasto (City)
Miejscowość, dla której budujemy wizualizację tras komunikacji miejskiej. Każde miasto ma własny zestaw linii i danych GTFS.

## Linia (Route)
Publiczny numer obsługiwany przez przewoźnika (np. „702"), w ramach którego jeżdżą tramwaje (TRAM) albo autobusy (BUS). Jedna linia może mieć wiele wariantów tras.

## Kierunek (Direction)
Jeden przebieg linii — od pierwszego przystanku do ostatniego. Linia ma co najmniej dwa kierunki (tam i z powrotem).

## Przystanek (Stop)
Punkt zatrzymania pojazdu na trasie. Ma nazwę, współrzędne oraz opcjonalnie strefę taryfową (A/B/C/D) i oznaczenie audio (kolejność odczytu nazwy).

## Kształt linii (Shape)
Geometria drogi, po której jedzie pojazd — ciąg współrzędnych tworzący trasę między przystankami.

## Przejazd (Ride)
Symulowana jazda pojazdu od początku do końca kształtu, przystanek po przystanku. Pojazd porusza się po kształcie, zatrzymuje się na przystankach, ogłasza ich nazwy i rysuje za sobą ślad przejechanej trasy.

### Mechanika przejazdu (Ride mechanics)
Czysta matematyka jazdy, niezależna od mapy i audio:
- **Prędkość po segmencie (segment speed)** — profil przyspieszanie → jazda → hamowanie (trapez) dla jednego odcinka między przystankami.
- **Sektor pojazdu (vehicle sector)** — uznaniowa kategoria zwrotu pojazdu na podstawie kierunku geograficznego (`left` / `right` / `oncoming`).
- **Przyłożenie przystanków (stop snapping)** — przypisanie każdemu przystankowi punktu najbliższego na kształcie oraz jego odległości od początku trasy.

## Ślad przejazdu (Trail)
Linia rysowana na mapie za poruszającym się pojazdem, od początku trasy do aktualnej pozycji.
