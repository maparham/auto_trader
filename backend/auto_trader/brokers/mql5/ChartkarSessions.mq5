// Chartkar: dump every symbol's weekly TRADE sessions to
// MQL5/Files/chartkar_sessions.json, for the mt5-self broker's market-hours
// badge and order ticket. The terminal's MCP has no sessions tool, so the
// backend runs this script on a chart (chart_add_script) and reads the file.
//
// Format: {"generated": <unix UTC>, "serverOffset": <server minus UTC, s>,
//          "symbols": {"<name>": [[[from, to], ...] x 7 days, Sunday first]},
//          "leverage": {"<name>": <notional / margin of 1 lot>}}
// from/to are seconds into the day, SERVER time; to may be 86400.
// leverage is the account's effective leverage on the symbol (5 = 5:1), from
// OrderCalcMargin and OrderCalcProfit (1% of the notional) in the account
// currency. Symbols with no price (not in Market Watch) are left out.
// Written to a temp file and moved, so a reader never sees half a file.
#property copyright "Chartkar"
#property version   "1.00"

string JsonEscape(const string s)
  {
   string out = s;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   return out;
  }

void OnStart()
  {
   const string tmp = "chartkar_sessions.tmp";
   const string dst = "chartkar_sessions.json";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
     {
      Print("ChartkarSessions: cannot open ", tmp, " error ", GetLastError());
      return;
     }
   datetime gmt = TimeGMT();
   long offset = (long)(TimeTradeServer() - gmt);
   FileWriteString(h, StringFormat("{\"generated\":%I64d,\"serverOffset\":%I64d,\"symbols\":{",
                                   (long)gmt, offset));
   int total = SymbolsTotal(false);
   for(int i = 0; i < total; i++)
     {
      string name = SymbolName(i, false);
      string row = (i > 0 ? "," : "") + "\"" + JsonEscape(name) + "\":[";
      for(int d = 0; d < 7; d++)
        {
         row += (d > 0 ? "[" : "[");
         datetime from, to;
         for(uint s = 0; SymbolInfoSessionTrade(name, (ENUM_DAY_OF_WEEK)d, s, from, to); s++)
            row += StringFormat("%s[%I64d,%I64d]", (s > 0 ? "," : ""), (long)from, (long)to);
         row += (d < 6 ? "]," : "]");
        }
      FileWriteString(h, row + "]");
     }
   FileWriteString(h, "},\"leverage\":{");
   bool first = true;
   for(int i = 0; i < total; i++)
     {
      string name = SymbolName(i, false);
      double ask = SymbolInfoDouble(name, SYMBOL_ASK);
      double margin = 0.0, profit = 0.0;
      if(ask <= 0.0
         || !OrderCalcMargin(ORDER_TYPE_BUY, name, 1.0, ask, margin)
         || !OrderCalcProfit(ORDER_TYPE_BUY, name, 1.0, ask, ask * 1.01, profit)
         || margin <= 0.0 || profit <= 0.0)
         continue;
      FileWriteString(h, StringFormat("%s\"%s\":%.4f", (first ? "" : ","), JsonEscape(name),
                                      profit * 100.0 / margin));
      first = false;
     }
   FileWriteString(h, "}}");
   FileClose(h);
   if(!FileMove(tmp, 0, dst, FILE_REWRITE))
      Print("ChartkarSessions: cannot move to ", dst, " error ", GetLastError());
  }
