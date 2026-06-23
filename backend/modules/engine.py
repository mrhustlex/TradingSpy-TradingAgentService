import backtrader as bt

import importlib.util
import os
import uuid
import sys
import numpy as np
import logging
import multiprocessing

logger = logging.getLogger(__name__)

# Ensure modules directory is on sys.path for subprocess workers (ProcessPoolExecutor with spawn)
_modules_dir = os.path.dirname(os.path.abspath(__file__))
if _modules_dir not in sys.path:
    sys.path.insert(0, _modules_dir)

# Setup basic logging for subprocess workers (may not inherit parent's config with spawn)
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(name)s: %(message)s')

try:
    from strategies import STRATEGY_MAP
except ImportError:
    from .strategies import STRATEGY_MAP

def load_custom_strategy(file_path, class_name):
    """Dynamically loads a strategy class from a user file with a totally unique module name."""
    try:
        if not os.path.exists(file_path):
            logger.error(f"Strategy file not found: {file_path}")
            return None
        # Use a random ID to prevent module name collisions in parallel processes
        unique_mod_id = f"custom_strat_{uuid.uuid4().hex}"
        spec = importlib.util.spec_from_file_location(unique_mod_id, file_path)
        if spec is None or spec.loader is None:
            logger.error(f"Failed to create spec for {file_path} (loader is None)")
            return None
            
        module = importlib.util.module_from_spec(spec)
        # Register the module so it's globally accessible in this process
        sys.modules[unique_mod_id] = module
        spec.loader.exec_module(module)
        
        cls = getattr(module, class_name, None)
        if cls is None:
            logger.error(f"Class '{class_name}' not found in module loaded from {file_path}")
        return cls
    except Exception as e:
        import traceback
        logger.error(f"FAILED to load {class_name} from {file_path}: {e}")
        logger.error(traceback.format_exc())
        return None

class TradeMarkerAnalyzer(bt.Analyzer):
    """Logs all completed buy/sell orders for chart visualization."""
    def __init__(self):
        self.markers = []

    def notify_order(self, order):
        if order.status in [order.Completed]:
            # Convert backtrader serial date to ISO string
            dt = self.strategy.data.datetime.datetime()
            
            # Get current position size after order
            pos = self.strategy.getposition(order.data).size
            
            self.markers.append({
                'time': dt.strftime('%Y-%m-%d %H:%M:%S'),
                'type': 'Buy' if order.isbuy() else 'Sell',
                'price': order.executed.price,
                'size': order.executed.size,
                'pos_size': pos,
                'value': self.strategy.broker.getvalue()
            })

    def get_analysis(self):
        return self.markers

class ComprehensiveAnalyzer(bt.Analyzer):
    """Lightweight trading statistics analyzer."""
    
    def __init__(self):
        self.trades = []
        self.open_trades = []
        self.start_value = 0.0
        self.peak_value = 0.0
        self.max_drawdown = 0.0
        self.daily_values = []  # Track for Sharpe ratio
        
    def start(self):
        self.start_value = self.strategy.broker.getvalue()
        self.peak_value = self.start_value
        
    def next(self):
        current_value = self.strategy.broker.getvalue()
        self.daily_values.append(current_value)
        
        # Calculate drawdown
        if current_value > self.peak_value:
            self.peak_value = current_value
        else:
            drawdown = (self.peak_value - current_value) / self.peak_value
            if drawdown > self.max_drawdown:
                self.max_drawdown = drawdown
    
    def notify_trade(self, trade):
        if trade.isclosed:
            self.trades.append({
                'pnl': trade.pnlcomm,  # Use pnlcomm directly (includes commission)
                'long': trade.long
            })
        elif trade.isopen and trade not in self.open_trades:
            # Track open trades (like BuyAndHold)
            self.open_trades.append(trade)
    
    def get_analysis(self):
        # Include both closed and open trades in count
        total_trades = len(self.trades) + len(self.open_trades)
        
        if not self.trades and not self.open_trades:
            return {
                'total_trades': 0, 'winning_trades': 0, 'losing_trades': 0,
                'win_rate': 0, 'total_return': 0, 'sharpe_ratio': self._calculate_sharpe(),
                'max_drawdown': round(self.max_drawdown * 100, 2), 'profit_factor': 0, 'avg_win': 0,
                'avg_loss': 0, 'payoff_ratio': 0, 'total_pnl': 0,
                'total_commission': 0, 'gross_profit': 0, 'gross_loss': 0
            }
            
        # Fast calculations (only for closed trades)
        closed_trades = len(self.trades)
        wins = [t['pnl'] for t in self.trades if t['pnl'] > 0]
        losses = [t['pnl'] for t in self.trades if t['pnl'] < 0]
        
        winning_trades = len(wins)
        losing_trades = len(losses)
        win_rate = (winning_trades / closed_trades) * 100 if closed_trades > 0 else 0
        
        total_pnl = sum(t['pnl'] for t in self.trades)
        avg_win = sum(wins) / len(wins) if wins else 0
        avg_loss = abs(sum(losses) / len(losses)) if losses else 0
        payoff_ratio = avg_win / avg_loss if avg_loss > 0 else 0
        
        gross_profit = sum(wins) if wins else 0
        gross_loss = abs(sum(losses)) if losses else 0
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else 0
        
        # Simple total return calculation
        final_value = self.strategy.broker.getvalue()
        total_return = ((final_value - self.start_value) / self.start_value) * 100 if self.start_value > 0 else 0
        
        return {
            'total_trades': total_trades,
            'winning_trades': winning_trades,
            'losing_trades': losing_trades,
            'win_rate': round(win_rate, 2),
            'total_return': round(total_return, 2),
            'sharpe_ratio': self._calculate_sharpe(),
            'max_drawdown': round(self.max_drawdown * 100, 2),
            'profit_factor': round(profit_factor, 3),
            'avg_win': round(avg_win, 2),
            'avg_loss': round(avg_loss, 2),
            'payoff_ratio': round(payoff_ratio, 3),
            'total_pnl': round(total_pnl, 2),
            'total_commission': 0,  # Skip for speed
            'gross_profit': round(gross_profit, 2),
            'gross_loss': round(gross_loss, 2)
        }
    
    def _calculate_sharpe(self):
        """Calculate annualized Sharpe ratio from daily portfolio values."""
        if len(self.daily_values) < 2:
            return 'N/A'
        
        try:
            returns = np.diff(self.daily_values) / self.daily_values[:-1]
            if len(returns) == 0 or np.std(returns) == 0:
                return 'N/A'
            
            # Annualized Sharpe (assuming 252 trading days)
            sharpe = (np.mean(returns) / np.std(returns)) * np.sqrt(252)
            return round(sharpe, 3)
        except:
            return 'N/A'


def run_single_backtest(params):
    """Execution wrapper for a single strategy/dataset combination."""
    strat_input, datapath, stake, trail, start_date, end_date = params[:6]
    initial_cash = params[6] if len(params) > 6 else 100000.0
    commission = params[7] if len(params) > 7 else 0.001
    
    try:
        # 1. Identify Strategy Class
        if isinstance(strat_input, str):
            strat_class = STRATEGY_MAP.get(strat_input)
        else:
            # Load dynamically inside the worker process
            strat_class = load_custom_strategy(strat_input['file'], strat_input['class'])

        if not strat_class:
            logger.error(f"Strategy class could not be loaded (input: {strat_input})")
            return initial_cash, [], {}  # Return initial_cash (not 0) — failure, not -100% loss
            
        # 2. Setup Cerebro with performance optimizations
        cerebro = bt.Cerebro(
            runonce=True,      # Run in vector mode (much faster)
            preload=True,      # Preload all data (faster access)
            exactbars=False,   # Keep all bars in memory (needed for indicators)
            stdstats=False,    # Disable default observers (we use custom analyzers)
            optreturn=False    # Return strategy instances (not needed for optimization)
        )
        
        # Robust parameter injection
        strat_params = {}
        # Try to detect if strategy supports trailpercent
        try:
            # Check if trailpercent is in the class params
            if hasattr(strat_class, 'params'):
                p_items = dict(strat_class.params._getitems())
                if 'trailpercent' in p_items:
                    strat_params['trailpercent'] = trail
        except:
            pass
        
        cerebro.addstrategy(strat_class, **strat_params)
        
        # 3. Load Data with Date Filtering
        import datetime
        fromdate = None
        todate = None
        if start_date:
            try: fromdate = datetime.datetime.strptime(start_date, '%Y-%m-%d')
            except: pass
        if end_date:
            try: todate = datetime.datetime.strptime(end_date, '%Y-%m-%d')
            except: pass

        # Auto-detect date format from CSV file
        dtformat = '%Y-%m-%d'  # Default for daily data
        try:
            with open(datapath, 'r') as f:
                f.readline()  # Skip header
                first_line = f.readline()
                if first_line:
                    first_date = first_line.split(',')[0].strip()
                    # If it contains a space, it has time component
                    if ' ' in first_date:
                        dtformat = '%Y-%m-%d %H:%M:%S'
        except:
            pass  # Use default if detection fails

        data = bt.feeds.GenericCSVData(
            dataname=datapath,
            fromdate=fromdate,
            todate=todate,
            nullvalue=0.0,
            dtformat=dtformat,
            datetime=0,
            open=1,
            high=2,
            low=3,
            close=4,
            volume=5,
            openinterest=6,
            headers=True # Matches pandas to_csv header
        )
        cerebro.adddata(data)
        
        # 4. Broker config
        START_CASH = initial_cash
        cerebro.broker.setcash(START_CASH)
        cerebro.addsizer(bt.sizers.PercentSizer, percents=int(stake))
        cerebro.broker.setcommission(commission=commission)

        # 5. Add Analyzers
        cerebro.addanalyzer(TradeMarkerAnalyzer, _name='markers')
        cerebro.addanalyzer(ComprehensiveAnalyzer, _name='comprehensive')

        # 6. Execute
        results = cerebro.run()
        if not results:
            logger.warning(f"Backtrader.run() returned no results for {strat_input}")
            return START_CASH, [], {}

        final_val = cerebro.broker.getvalue()
        markers = results[0].analyzers.markers.get_analysis()
        stats = results[0].analyzers.comprehensive.get_analysis()
        
        return final_val, markers, stats
        
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        logger.error(f"BACKTEST CRITICAL RUNTIME ERROR: {e}")
        logger.error(tb)
        return initial_cash, [], {
            "__runtime_error": str(e),
            "__runtime_traceback": tb,
        }


def _run_single_backtest_child(params, result_queue):
    try:
        result_queue.put(run_single_backtest(params))
    except Exception as e:
        import traceback
        result_queue.put((
            params[6] if len(params) > 6 else 100000.0,
            [],
            {"__runtime_error": str(e), "__runtime_traceback": traceback.format_exc()},
        ))


def run_single_backtest_with_timeout(params, timeout_seconds=45):
    """Run one optimization combo in a killable child process."""
    initial_cash = params[6] if len(params) > 6 else 100000.0
    methods = multiprocessing.get_all_start_methods()
    ctx = multiprocessing.get_context("fork" if "fork" in methods else methods[0])
    result_queue = ctx.Queue(maxsize=1)
    proc = ctx.Process(target=_run_single_backtest_child, args=(params, result_queue))
    proc.daemon = True
    proc.start()
    proc.join(timeout_seconds)

    if proc.is_alive():
        proc.terminate()
        proc.join(5)
        if proc.is_alive():
            proc.kill()
            proc.join(2)
        return initial_cash, [], {
            "__runtime_error": f"Backtest timed out after {timeout_seconds}s",
            "__runtime_traceback": (
                "Generated strategy did not finish inside the runtime guard. "
                "It may contain extremely slow logic, an infinite loop, or a Backtrader pattern that stalls execution."
            ),
        }

    if proc.exitcode not in (0, None) and result_queue.empty():
        return initial_cash, [], {
            "__runtime_error": f"Backtest worker exited with code {proc.exitcode}",
            "__runtime_traceback": "Generated strategy crashed the isolated backtest worker before returning a result.",
        }

    try:
        return result_queue.get_nowait()
    except Exception:
        return initial_cash, [], {
            "__runtime_error": "Backtest worker returned no result",
            "__runtime_traceback": "Generated strategy finished without producing a Backtrader result.",
        }


def find_best_parallel(strat_input, datapath, stake_range=None, trail_range=None, start_date=None, end_date=None, initial_cash=100000.0, commission=0.001):
    """Optimized parameter search with reduced combinations and faster execution."""
    # Reduce optimization space for speed
    stakes = stake_range if stake_range else [30, 70, 95]  # Reduced from 7 to 3
    trails = trail_range if trail_range else [0.0, 0.10]   # Reduced from 4 to 2
    
    # If ranges are too large, sample them
    if len(stakes) > 5:
        stakes = stakes[::len(stakes)//5]  # Sample every nth element
    if len(trails) > 3:
        trails = trails[::len(trails)//3]
    
    configs = []
    for stake in stakes:
        for trail in trails:
            configs.append((strat_input, datapath, stake, trail, start_date, end_date, initial_cash, commission))
    
    logger.info("Running %s optimization combinations (reduced for speed)", len(configs))
    
    combo_timeout = int(os.getenv("BACKTEST_COMBO_TIMEOUT_SECONDS", "45"))
    results = [run_single_backtest_with_timeout(config, combo_timeout) for config in configs]
    
    best_val = -float("inf")
    best_markers = []
    best_stats = {}
    best_cfg = {'stake': stakes[-1], 'trail': trails[0]}
    
    for i, (val, markers, stats) in enumerate(results):
        if val > best_val:
            best_val = val
            best_markers = markers
            best_stats = stats
            stake, trail = configs[i][2], configs[i][3]
            best_cfg = {'stake': stake, 'trail': trail}
            
    return best_val, best_cfg, best_markers, best_stats
