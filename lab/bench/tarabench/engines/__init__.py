"""Every engine is run(spec, ctx) -> the pack folder it wrote."""


def _lazy(name):
    def run(spec, ctx):
        import importlib
        return importlib.import_module(f'.{name}', __name__).run(spec, ctx)
    return run


ENGINES = {name: _lazy(name) for name in ('steer', 'probe', 'features', 'diff', 'circuit', 'graph')}
