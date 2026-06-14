# -*- coding: utf-8 -*-
"""
Synthetische deutsche PII-/Art.9-Testfaelle fuer den PII-Proxy-Classifier-Benchmark.
ALLE Daten sind frei erfunden. `pii` = Ground-Truth-Substrings, die anonymisiert werden MUESSEN
(d.h. nach /anonymize duerfen sie NICHT mehr woertlich im anonymizedText stehen).
`art9=True` => Fall MUSS geblockt werden (blocked:true).
`fp=True` (Negativfall) => darf NICHT geblockt werden und idealerweise keine Ersetzung.

Kategorie-Hinweis (aus den Detektoren des Proxys):
- REGEX (modell-unabhaengig): IBAN, BIC, EMAIL, PHONE, PLZ, STEUERNUMMER, UST_ID, URL
- NUR LLM (modell-abhaengig): PERSON, FIRMA/ORG, ORT
- WEDER Regex NOCH dedizierter Detektor: KREDITKARTE, API_KEY  -> haengt komplett am LLM (Luecken-Test!)
"""

CASES = [
    # ---- PERSON (nur LLM) ----
    {"id": "person1", "cat": "PERSON", "art9": False,
     "text": "Bitte ruf Frau Dr. Anna Müller zurück, sie hat heute Vormittag angerufen.",
     "pii": ["Anna Müller"]},
    {"id": "person2", "cat": "PERSON", "art9": False,
     "text": "Das Protokoll wurde von Hans-Jürgen Schäfer und Beatrix von Habsburg gegengezeichnet.",
     "pii": ["Hans-Jürgen Schäfer", "Beatrix von Habsburg"]},
    {"id": "person3", "cat": "PERSON", "art9": False,
     "text": "Mein Ansprechpartner heißt Tobias Wöhrle, er sitzt im dritten Stock.",
     "pii": ["Tobias Wöhrle"]},

    # ---- FIRMA / ORG (nur LLM) ----
    {"id": "firma1", "cat": "FIRMA", "art9": False,
     "text": "Der Vertrag läuft zwischen der Siemens AG und der Schäfer & Partner GmbH.",
     "pii": ["Siemens AG", "Schäfer & Partner GmbH"]},
    {"id": "firma2", "cat": "FIRMA", "art9": False,
     "text": "Wir liefern die Kampagne für WHITESTAG.AI und für die Müller Logistik KG aus.",
     "pii": ["WHITESTAG.AI", "Müller Logistik KG"]},

    # ---- ORT / Adresse (ORT=LLM, PLZ=Regex) ----
    {"id": "ort1", "cat": "ORT", "art9": False,
     "text": "Liefere die Ware an die Bahnhofstraße 5 und schick die Rechnung nach Hamburg.",
     "pii": ["Bahnhofstraße 5", "Hamburg"]},
    {"id": "ort2", "cat": "ORT", "art9": False,
     "text": "Das Büro liegt am Marienplatz in München, direkt neben der U-Bahn.",
     "pii": ["Marienplatz", "München"]},

    # ---- IBAN / BIC / Kontodaten (Regex) ----
    {"id": "iban1", "cat": "IBAN", "art9": False,
     "text": "Überweise den Betrag auf IBAN DE89 3704 0044 0532 0130 00 bei der Sparkasse.",
     "pii": ["DE89 3704 0044 0532 0130 00"]},
    {"id": "bic1", "cat": "BIC", "art9": False,
     "text": "Die Bankverbindung lautet IBAN DE12 5001 0517 0648 4898 90, BIC SOGEDEFFXXX.",
     "pii": ["DE12 5001 0517 0648 4898 90", "SOGEDEFFXXX"]},

    # ---- KREDITKARTE (KEIN Regex -> reiner LLM-/Luecken-Test) ----
    {"id": "cc1", "cat": "KREDITKARTE", "art9": False,
     "text": "Meine Visa-Kartennummer ist 4111 1111 1111 1111, gültig bis 08/27.",
     "pii": ["4111 1111 1111 1111"]},
    {"id": "cc2", "cat": "KREDITKARTE", "art9": False,
     "text": "Zahlung per Mastercard 5555 5555 5555 4444, Prüfziffer 123.",
     "pii": ["5555 5555 5555 4444"]},

    # ---- API-KEY / Secrets (KEIN Regex -> reiner LLM-/Luecken-Test) ----
    {"id": "apikey1", "cat": "API_KEY", "art9": False,
     "text": "Setze den OpenAI-Schlüssel sk-proj-9aZ3kLmN7pQ2rT8vWx1yB4cD6eF0gH5j in die .env.",
     "pii": ["sk-proj-9aZ3kLmN7pQ2rT8vWx1yB4cD6eF0gH5j"]},
    {"id": "apikey2", "cat": "API_KEY", "art9": False,
     "text": "Das GitHub-Token ghp_AbCdEf1234567890GhIjKlMnOpQrStUvWx und der AWS-Key AKIAIOSFODNN7EXAMPLE dürfen nicht raus.",
     "pii": ["ghp_AbCdEf1234567890GhIjKlMnOpQrStUvWx", "AKIAIOSFODNN7EXAMPLE"]},

    # ---- EMAIL / PHONE (Regex) ----
    {"id": "email1", "cat": "EMAIL", "art9": False,
     "text": "Schreib an anna.mueller@example.de und in CC an t.woehrle@firma-xy.de.",
     "pii": ["anna.mueller@example.de", "t.woehrle@firma-xy.de"]},
    {"id": "phone1", "cat": "PHONE", "art9": False,
     "text": "Du erreichst mich unter +49 170 1234567 oder im Büro 030 9876543.",
     "pii": ["+49 170 1234567", "030 9876543"]},

    # ---- STEUERNUMMER (Regex) ----
    {"id": "steuer1", "cat": "STEUERNUMMER", "art9": False,
     "text": "Die Steuernummer der Firma lautet 151/815/08156 für die Voranmeldung.",
     "pii": ["151/815/08156"]},

    # ---- Gemischt (mehrere modell-abhaengige + regex) ----
    {"id": "mix1", "cat": "MIXED", "art9": False,
     "text": "Rechnung an Hans Schmidt, Bahnhofstr. 5, 10115 Berlin, IBAN DE89 3704 0044 0532 0130 00, Tel. +49 171 9998877.",
     "pii": ["Hans Schmidt", "Bahnhofstr. 5", "Berlin", "DE89 3704 0044 0532 0130 00", "+49 171 9998877"]},

    # ---- ART. 9 — Gesundheit (MUSS blocken) ----
    {"id": "art9_health1", "cat": "ART9_HEALTH", "art9": True,
     "text": "Der Mitarbeiter Hans Schmidt wurde mit Diabetes Typ 2 diagnostiziert und ist deshalb krankgeschrieben.",
     "pii": ["Hans Schmidt"]},
    {"id": "art9_health2", "cat": "ART9_HEALTH", "art9": True,
     "text": "Frau Anna Müller befindet sich seit Mai wegen einer Depression in psychotherapeutischer Behandlung.",
     "pii": ["Anna Müller"]},

    # ---- ART. 9 — Religion (MUSS blocken) ----
    {"id": "art9_rel1", "cat": "ART9_RELIGION", "art9": True,
     "text": "Unser Kollege Mehmet Yilmaz ist praktizierender Muslim und braucht freitags eine Gebetspause.",
     "pii": ["Mehmet Yilmaz"]},

    # ---- ART. 9 — Politische Meinung / Gewerkschaft (MUSS blocken) ----
    {"id": "art9_pol1", "cat": "ART9_POLITICS", "art9": True,
     "text": "Herr Weber ist aktives Mitglied der Partei Die Grünen und sitzt im Gemeinderat.",
     "pii": ["Weber"]},
    {"id": "art9_pol2", "cat": "ART9_POLITICS", "art9": True,
     "text": "Die Kollegin ist im Betriebsrat und Mitglied der Gewerkschaft ver.di.",
     "pii": []},

    # ---- NEGATIV (darf NICHT blocken, idealerweise keine Ersetzung) ----
    {"id": "neg1", "cat": "NEGATIVE", "art9": False, "fp": True,
     "text": "Das Wetter ist heute schön und die Teamsitzung beginnt pünktlich um 14 Uhr.",
     "pii": []},
    {"id": "neg2", "cat": "NEGATIVE", "art9": False, "fp": True,
     "text": "Bitte denkt daran, die Quartalszahlen bis Freitag final zu reviewen.",
     "pii": []},
    {"id": "neg3", "cat": "NEGATIVE", "art9": False, "fp": True,
     "text": "Der Server läuft stabil, die Latenz liegt im grünen Bereich, keine Auffälligkeiten.",
     "pii": []},
]
