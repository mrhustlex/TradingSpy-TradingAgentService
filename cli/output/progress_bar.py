"""Progress bar and spinner utilities."""

import click
from contextlib import contextmanager


@contextmanager
def spinner(message="Processing"):
    """Show a spinning progress indicator."""
    
    with click.progressbar(
        length=1,
        label=message,
        show_eta=False,
        show_pos=True,
        fill_char='█',
        empty_char=' ',
    ) as bar:
        bar.update(1)
        yield


@contextmanager
def progress_bar(total, label="Processing"):
    """Show a progress bar for iterative operations."""
    
    with click.progressbar(
        length=total,
        label=label,
        show_eta=True,
        show_pos=True,
        fill_char='█',
        empty_char=' ',
    ) as bar:
        yield bar


def simple_spinner():
    """Return a simple spinner character sequence."""
    
    spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    return spinners
