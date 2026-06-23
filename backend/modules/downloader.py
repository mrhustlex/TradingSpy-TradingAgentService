import yfinance as yf
import pandas as pd
import datetime
import os
import logging

logger = logging.getLogger(__name__)

def download_ticker_data(ticker, start_date=None, end_date=None, interval='1d', period=None, output_dir='datas', extended_hours=False):
    """
    Downloads and saves data for a single ticker in Backtrader CSV format.
    Ensures safe handling of yfinance API responses and formatting.
    """
    try:
        ticker = ticker.upper()
        t_obj = yf.Ticker(ticker)
        
        # 1. Fetch data from yfinance
        if period:
            logger.info(f"[{ticker}] Requesting {period} history at {interval}...")
            # Note: 'threads' is NOT supported by Ticker.history() in >=0.2.0
            data = t_obj.history(period=period, interval=interval, auto_adjust=True, prepost=bool(extended_hours))
        else:
            if not start_date:
                start_date = '2000-01-01'
            if not end_date:
                end_date = datetime.date.today().strftime('%Y-%m-%d')
            logger.info(f"[{ticker}] Requesting {start_date} to {end_date} at {interval}...")
            data = t_obj.history(start=start_date, end=end_date, interval=interval, auto_adjust=True, prepost=bool(extended_hours))
        
        # 2. Basic validation
        if data is None or data.empty:
            logger.warning(f"[{ticker}] Empty result returned for {interval}/{period or start_date}")
            return None

        # Fix for yfinance MultiIndex columns
        if isinstance(data.columns, pd.MultiIndex):
            data.columns = data.columns.get_level_values(0)

        # 3. Save Logic
        os.makedirs(output_dir, exist_ok=True)
        if period:
            suffix = "-extended" if extended_hours else ""
            filename = f"{ticker.lower()}-{interval}-{period}{suffix}.txt"
        else:
            s_year = start_date.split('-')[0]
            e_year = end_date.split('-')[0] if end_date else datetime.datetime.now().year
            filename = f"{ticker.lower()}-{interval}-{s_year}-{e_year}.txt"
            
        filepath = os.path.join(output_dir, filename)

        # 4. Smart Update/Sync Logic
        existing_data = None
        if os.path.exists(filepath):
            try:
                existing_data = pd.read_csv(filepath)
                existing_data['Date'] = pd.to_datetime(existing_data['Date'])
                
                # If we're doing a period-based fetch (e.g. 1d/5y), we might just overwrite 
                # UNLESS it's intraday where history is limited.
                # For simplicity, if file exists, we try to fetch from last date.
                last_date = existing_data['Date'].max()
                
                # For intraday 'period' requests (e.g. '7d'), yfinance returns distinct recent windows.
                # If we want to build a long history, we should fetch 'recent' and append.
                # If the request is manual 'start/end', just standard download.
                
                if period: 
                    # If this is a 'sync' or period request, we try to append only new data
                    # Determine start date for new data
                    start_fetch = last_date + datetime.timedelta(minutes=1 if 'm' in interval else 1440)
                    
                    if start_fetch < datetime.datetime.now():
                        logger.info(f"[{ticker}] File exists (last: {last_date}). Fetching new data from {start_fetch}...")
                        new_data = t_obj.history(start=start_fetch, interval=interval, auto_adjust=True, prepost=bool(extended_hours))
                        
                        if isinstance(new_data.columns, pd.MultiIndex):
                            new_data.columns = new_data.columns.get_level_values(0)
                            
                        if new_data is not None and not new_data.empty:
                            new_data.reset_index(inplace=True)
                            date_col = 'Date' if 'Date' in new_data.columns else 'Datetime'
                            
                            logger.info(f"[{ticker}] Found {len(new_data)} new rows.")
                            
                            df_new = pd.DataFrame()
                            # Ensure timezone naive for consistency
                            df_new['Date'] = pd.to_datetime(new_data[date_col]).dt.tz_localize(None)
                            df_new['Open'] = pd.to_numeric(new_data['Open'], errors='coerce')
                            df_new['High'] = pd.to_numeric(new_data['High'], errors='coerce')
                            df_new['Low'] = pd.to_numeric(new_data['Low'], errors='coerce')
                            df_new['Close'] = pd.to_numeric(new_data['Close'], errors='coerce')
                            df_new['Volume'] = pd.to_numeric(new_data['Volume'], errors='coerce').fillna(0)
                            df_new['OpenInterest'] = 0
                            
                            df_new.dropna(subset=['Open', 'High', 'Low', 'Close'], inplace=True)
                            
                            # Concatenate and deduplicate
                            updated_df = pd.concat([existing_data, df_new])
                            updated_df.drop_duplicates(subset=['Date'], keep='last', inplace=True)
                            updated_df.sort_values('Date', inplace=True)
                            
                            updated_df.to_csv(filepath, index=False)
                            return filepath
                        else:
                             logger.info(f"[{ticker}] No new data found.")
                             return filepath
            except Exception as e:
                logger.warning(f"Failed to read existing file for update: {e}. Overwriting.")

        # 5. Full Process (New File or Overwrite fallback)
        # Required columns: Date,Open,High,Low,Close,Volume,OpenInterest
        data.reset_index(inplace=True)
        date_col = 'Date' if 'Date' in data.columns else 'Datetime'
        
        logger.info(f"[{ticker}] Saving {len(data)} rows ({data[date_col].min()} to {data[date_col].max()})")
        
        df = pd.DataFrame()
        # Ensure timezone naive for consistency
        df['Date'] = pd.to_datetime(data[date_col]).dt.tz_localize(None)
        df['Open'] = pd.to_numeric(data['Open'], errors='coerce')
        df['High'] = pd.to_numeric(data['High'], errors='coerce')
        df['Low'] = pd.to_numeric(data['Low'], errors='coerce')
        df['Close'] = pd.to_numeric(data['Close'], errors='coerce')
        df['Volume'] = pd.to_numeric(data['Volume'], errors='coerce').fillna(0)
        df['OpenInterest'] = 0
        
        # Ensure price sanity
        df.dropna(subset=['Open', 'High', 'Low', 'Close'], inplace=True)
        
        df.to_csv(filepath, index=False)
        return filepath
        
    except Exception as e:
        logger.error(f"[{ticker}] DOWNLOAD ERROR: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return None
