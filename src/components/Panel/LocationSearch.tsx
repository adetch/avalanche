"use client";

import { useState, useRef, useEffect } from "react";

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY;

interface SearchResult {
  id: string;
  place_name: string;
  center: [number, number];
}

interface LocationSearchProps {
  onSelect: (center: [number, number], name: string) => void;
}

export default function LocationSearch({ onSelect }: LocationSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (query.length < 3) {
      setResults([]);
      setOpen(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${MAPTILER_KEY}&limit=5`
        );
        const data = await res.json();
        const features = data.features ?? [];
        setResults(
          features.map((f: { id: string; place_name: string; center: [number, number] }) => ({
            id: f.id,
            place_name: f.place_name,
            center: f.center,
          }))
        );
        setOpen(features.length > 0);
      } catch {
        setResults([]);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const handleSelect = (result: SearchResult) => {
    setQuery(result.place_name);
    setOpen(false);
    setResults([]);
    onSelect(result.center, result.place_name);
  };

  return (
    <div className="relative">
      <label className="text-sm font-medium text-zinc-700">Location</label>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search address or place..."
        className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
      />
      {open && results.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-zinc-200 bg-white shadow-lg">
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => handleSelect(r)}
                className="w-full px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100"
              >
                {r.place_name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
