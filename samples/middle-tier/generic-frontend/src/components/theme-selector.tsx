"use client";

import { useEffect, useState } from "react";
import { Palette } from "lucide-react";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

type Theme = "light" | "dark" | "dark-blue";

const themes: Record<Theme, { label: string; color: string }> = {
  light: { label: "Light", color: "#000000" },
  dark: { label: "Black", color: "#000000" },
  "dark-blue": { label: "Dark Blue", color: "#f08030" },
};

function applyTheme(theme: Theme) {
  document.documentElement.classList.remove("dark", "dark-blue");
  if (theme !== "light") {
    document.documentElement.classList.add(theme);
  }
}

interface Props {
  iconOnly?: boolean;
}

export default function ThemeSelector({ iconOnly = false }: Props) {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    const initial =
      stored ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light");
    setTheme(initial);
    applyTheme(initial);
  }, []);

  const handleChange = (value: Theme) => {
    setTheme(value);
    localStorage.setItem("theme", value);
    applyTheme(value);
  };

  return (
    <Select value={theme} onValueChange={handleChange}>
      <SelectTrigger className={iconOnly ? "w-10" : "w-[150px]"}>
        <span className="flex items-center gap-2">
          <Palette data-lucide="palette" className="w-4 h-4" />
          <span
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: themes[theme].color }}
          />
          {iconOnly ? null : themes[theme].label}
        </span>
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(themes) as Theme[]).map((t) => (
          <SelectItem key={t} value={t}>
            <span className="flex items-center gap-2">
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: themes[t].color }}
              />
              {themes[t].label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
